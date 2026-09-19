/**
 * Two-stage Jev skill router — protocol from
 * https://docs.typesafe.ai/cookbooks/skill_suggestion.md
 * (Hermes thresholds: gate 0.30 / fits 0.40).
 */

import { readFile } from "node:fs/promises";
import {
  choice,
  noul,
  type ChoiceQuestion,
  type NoulQuestion,
  type Question,
  type SystemOneResult,
  type TypeSafeClient,
} from "@typesafe-ai/sdk";
import pLimit from "p-limit";
import { clampShortlistSize } from "./config.ts";

export type RosterSkill = {
  name: string;
  description: string;
  filePath: string;
};

export type Suggestion = {
  skill: string | null;
  location: string | null;
  reason: string;
  gate: number;
  shortlist: string[];
  fits: Record<string, number>;
};

/** Minimal client surface so tests can fake systemOne without the full SDK. */
export type SuggestClient = Pick<TypeSafeClient, "systemOne">;

export type SuggestOptions = {
  signal?: AbortSignal;
  /** Max stage-1 candidates into stage-2. Default 3. */
  shortlistSize?: number;
};

const STAGE1_CONCURRENCY = 3;
const EXCERPT_CHARS = 700;
const GATE_THRESHOLD = 0.3;
const FITS_THRESHOLD = 0.4;
const MAX_CHOICES = 255;
const CHUNK_CHOICES = MAX_CHOICES - 1; // room for none_of_these when chunked
const NONE_OPTION = "none_of_these";
const NONE_THRESHOLD = 0.5;

const CHOICE_INSTRUCTIONS =
  "Which of these skills, if any, is the right one to load to help with the user's latest request?";

const GATE_QUESTIONS: Record<string, string> = {
  acts_on_user_system:
    "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
  would_follow_documented_procedure:
    "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
  prose_suffices:
    "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
};

const INVERTED = new Set(["prose_suffices"]);

const RERANK_INSTRUCTIONS =
  "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.";

type Questions = Record<string, Question>;

export function none(
  reason: string,
  extras: Partial<Pick<Suggestion, "gate" | "shortlist" | "fits">> = {},
): Suggestion {
  return {
    skill: null,
    location: null,
    reason,
    gate: 0,
    shortlist: [],
    fits: {},
    ...extras,
  };
}

function chunkRoster<T>(items: T[], size: number): T[][] {
  if (size > MAX_CHOICES) throw new Error(`chunk size ${size} exceeds API cap ${MAX_CHOICES}`);
  if (items.length === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function answerNoul(answers: SystemOneResult<Questions>["answers"], key: string): number {
  const answer = answers[key];
  return answer?.type === "noul" ? answer.noul : 0;
}

async function skillExcerpt(skill: RosterSkill, chars: number): Promise<string> {
  try {
    const raw = await readFile(skill.filePath, "utf8");
    const body = raw.replace(/^---[\s\S]*?---\s*/, "");
    return body.trim().slice(0, chars);
  } catch {
    return "";
  }
}

/** Merge chunk rankings: keep best-chunk always, drop high-none chunks, pick top scores. */
export function pickShortlist(
  perChunk: Array<Array<[string, number]>>,
  nonePressure: number[],
  shortlistSize: number,
): string[] {
  const bestChunk = perChunk.reduce(
    (best, ranked, i) => ((ranked[0]?.[1] ?? -1) > (perChunk[best]?.[0]?.[1] ?? -1) ? i : best),
    0,
  );

  const candidates: Array<[string, number]> = [];
  for (let i = 0; i < perChunk.length; i++) {
    if (i !== bestChunk && nonePressure[i]! >= NONE_THRESHOLD) continue;
    candidates.push(...perChunk[i]!);
  }

  candidates.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const out: string[] = [];
  for (const [name] of candidates) {
    if (out.includes(name)) continue;
    out.push(name);
    if (out.length >= shortlistSize) break;
  }
  return out;
}

async function rankWide(
  client: SuggestClient,
  request: string,
  roster: RosterSkill[],
  shortlistSize: number,
  signal?: AbortSignal,
): Promise<{ gate: number; shortlist: string[] }> {
  const groups = chunkRoster(roster, CHUNK_CHOICES);
  const chunked = groups.length > 1;
  const state = { request };

  const calls = groups.map((group, index) => {
    const criteria: Record<string, string | null> = {};
    for (const skill of group) criteria[skill.name] = skill.description;
    if (chunked) criteria[NONE_OPTION] = "None of these skills fit the request.";
    const questions: Questions = {
      which: choice(CHOICE_INSTRUCTIONS, criteria) as ChoiceQuestion,
    };
    if (index === 0) {
      for (const [key, text] of Object.entries(GATE_QUESTIONS)) {
        questions[`gate::${key}`] = noul(text) as NoulQuestion;
      }
    }
    return questions;
  });

  const limit = pLimit(STAGE1_CONCURRENCY);
  const responses = await Promise.all(
    calls.map((questions) => limit(() => client.systemOne({ state, questions }, { signal }))),
  );

  const perChunk: Array<Array<[string, number]>> = [];
  const nonePressure: number[] = [];
  for (const response of responses) {
    const which = response.answers.which;
    const probabilities = which?.type === "choice" ? which.probabilities : {};
    const ranked = Object.entries(probabilities)
      .filter(([name]) => name !== NONE_OPTION)
      .map(([name, prob]) => [name, Number(prob)] as [string, number])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    perChunk.push(ranked);
    nonePressure.push(Number((probabilities as Record<string, number>)[NONE_OPTION] ?? 0));
  }

  const first = responses[0]!;
  const gateValues: Record<string, number> = {};
  for (const key of Object.keys(GATE_QUESTIONS)) {
    gateValues[key] = answerNoul(first.answers, `gate::${key}`);
  }
  const oriented = Object.entries(gateValues).map(([k, v]) => (INVERTED.has(k) ? 1 - v : v));
  const gate = oriented.length ? oriented.reduce((a, b) => a + b, 0) / oriented.length : 0;

  return { gate, shortlist: pickShortlist(perChunk, nonePressure, shortlistSize) };
}

async function rerank(
  client: SuggestClient,
  request: string,
  names: string[],
  byName: Map<string, RosterSkill>,
  signal?: AbortSignal,
): Promise<{ winner: string | null; fits: Record<string, number> }> {
  const criteria: Record<string, string | null> = {
    [NONE_OPTION]: "None of these skills fit the request.",
  };
  const excerpts = await Promise.all(names.map((name) => skillExcerpt(byName.get(name)!, EXCERPT_CHARS)));
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const skill = byName.get(name)!;
    const excerpt = excerpts[i]!;
    criteria[name] = excerpt ? `${skill.description}\n\nSKILL.md: ${excerpt}` : skill.description;
  }

  const questions: Questions = {
    which: choice(RERANK_INSTRUCTIONS, criteria) as ChoiceQuestion,
  };
  for (const name of names) {
    const skill = byName.get(name)!;
    questions[`fits::${name}`] = noul(
      `Does the skill '${name}' do the specific thing the user's request asks for? It is described as: ${skill.description}`,
    );
  }

  const response = await client.systemOne({ state: { request }, questions }, { signal });
  const which = response.answers.which;
  const picked = which?.type === "choice" ? which.choice : undefined;
  const fits: Record<string, number> = {};
  for (const name of names) fits[name] = answerNoul(response.answers, `fits::${name}`);

  return {
    winner: !picked || picked === NONE_OPTION ? null : picked,
    fits,
  };
}

export async function suggest(
  client: SuggestClient,
  request: string,
  roster: RosterSkill[],
  options: SuggestOptions = {},
): Promise<Suggestion> {
  if (!roster.length) return none("roster empty");

  const shortlistSize = clampShortlistSize(options.shortlistSize);
  const byName = new Map(roster.map((s) => [s.name, s]));
  const wide = await rankWide(client, request, roster, shortlistSize, options.signal);

  if (wide.gate < GATE_THRESHOLD) {
    return none(`gate ${wide.gate.toFixed(2)} < ${GATE_THRESHOLD.toFixed(2)}: no skill wanted`, {
      gate: wide.gate,
    });
  }

  const shortlist = wide.shortlist;
  if (!shortlist.length) {
    return none("no shortlist", { gate: wide.gate });
  }

  const second = await rerank(client, request, shortlist, byName, options.signal);
  if (!second.winner) {
    return none("stage 2 picked none: no skill fits", {
      gate: wide.gate,
      shortlist,
      fits: second.fits,
    });
  }

  const winnerFits = second.fits[second.winner] ?? 0;
  if (winnerFits < FITS_THRESHOLD) {
    return none(`winner ${second.winner} fits ${winnerFits.toFixed(2)} < ${FITS_THRESHOLD.toFixed(2)}`, {
      gate: wide.gate,
      shortlist,
      fits: second.fits,
    });
  }

  const skill = byName.get(second.winner)!;
  return {
    skill: second.winner,
    location: skill.filePath,
    reason: `shortlist winner with fits ${winnerFits.toFixed(2)}`,
    gate: wide.gate,
    shortlist,
    fits: second.fits,
  };
}
