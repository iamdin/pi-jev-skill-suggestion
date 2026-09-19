/**
 * Two-stage Jev skill router — protocol from
 * https://docs.typesafe.ai/cookbooks/skill_suggestion.md
 * (Hermes thresholds: gate 0.30 / fits 0.40).
 */

import { readFile } from "node:fs/promises";
import {
  choice,
  noul,
  TypeSafeClient,
  type ChoiceQuestion,
  type NoulQuestion,
  type Question,
  type SystemOneResult,
} from "@typesafe-ai/sdk";

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

const SHORTLIST = 3;
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

async function ask(
  client: TypeSafeClient,
  state: Record<string, string>,
  questions: Questions,
  signal?: AbortSignal,
): Promise<SystemOneResult<Questions>> {
  return client.systemOne({ state, questions }, { signal });
}

async function rankWide(
  client: TypeSafeClient,
  request: string,
  roster: RosterSkill[],
  signal?: AbortSignal,
): Promise<{ gate: number; shortlist: string[]; chunks: number }> {
  const groups = chunkRoster(roster, CHUNK_CHOICES);
  const chunked = groups.length > 1;
  const state = { request, recent_context: "" };

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

  const responses =
    calls.length === 1
      ? [await ask(client, state, calls[0]!, signal)]
      : await Promise.all(calls.map((q) => ask(client, state, q, signal)));

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

  const bestChunk = perChunk.reduce(
    (best, ranked, i) => ((ranked[0]?.[1] ?? -1) > (perChunk[best]?.[0]?.[1] ?? -1) ? i : best),
    0,
  );

  const shortlisted: string[] = [];
  for (let i = 0; i < perChunk.length; i++) {
    if (i !== bestChunk && nonePressure[i]! >= NONE_THRESHOLD) continue;
    for (const [name] of perChunk[i]!.slice(0, SHORTLIST)) {
      if (!shortlisted.includes(name)) shortlisted.push(name);
    }
  }

  return { gate, shortlist: shortlisted, chunks: groups.length };
}

async function rerank(
  client: TypeSafeClient,
  request: string,
  names: string[],
  byName: Map<string, RosterSkill>,
  signal?: AbortSignal,
): Promise<{ winner: string | null; fits: Record<string, number> }> {
  const criteria: Record<string, string | null> = {
    [NONE_OPTION]: "None of these skills fit the request.",
  };
  for (const name of names) {
    const skill = byName.get(name)!;
    const excerpt = await skillExcerpt(skill, EXCERPT_CHARS);
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

  const response = await ask(client, { request, recent_context: "" }, questions, signal);
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
  client: TypeSafeClient,
  request: string,
  roster: RosterSkill[],
  signal?: AbortSignal,
): Promise<Suggestion> {
  const empty = (reason: string): Suggestion => ({
    skill: null,
    location: null,
    reason,
    gate: 0,
    shortlist: [],
    fits: {},
  });

  if (!roster.length) return empty("roster empty");

  const byName = new Map(roster.map((s) => [s.name, s]));
  const wide = await rankWide(client, request, roster, signal);

  if (wide.gate < GATE_THRESHOLD) {
    return {
      skill: null,
      location: null,
      reason: `gate ${wide.gate.toFixed(2)} < ${GATE_THRESHOLD.toFixed(2)}: no skill wanted`,
      gate: wide.gate,
      shortlist: [],
      fits: {},
    };
  }

  const shortlist = wide.shortlist.slice(0, Math.max(SHORTLIST, SHORTLIST * wide.chunks));
  if (!shortlist.length) {
    return { skill: null, location: null, reason: "no shortlist", gate: wide.gate, shortlist: [], fits: {} };
  }

  const second = await rerank(client, request, shortlist, byName, signal);
  if (!second.winner) {
    return {
      skill: null,
      location: null,
      reason: "stage 2 picked none: no skill fits",
      gate: wide.gate,
      shortlist,
      fits: second.fits,
    };
  }

  const winnerFits = second.fits[second.winner] ?? 0;
  if (winnerFits < FITS_THRESHOLD) {
    return {
      skill: null,
      location: null,
      reason: `winner ${second.winner} fits ${winnerFits.toFixed(2)} < ${FITS_THRESHOLD.toFixed(2)}`,
      gate: wide.gate,
      shortlist,
      fits: second.fits,
    };
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
