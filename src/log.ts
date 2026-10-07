/**
 * Local decision log (JSONL) + stats. Never leaves the machine.
 * Prompts are stored as a short hash + length only.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Trigger = "onPrompt" | "onDemand" | "shadow";
export type SkipWhy = "explicit-skill" | "trivial" | "extension-input";

type Base = { ts: string; session: string; turn: number };

export type LogRecord =
  | (Base & {
      t: "suggest";
      trigger: Trigger;
      prompt: string; // hash
      promptChars: number;
      roster: number;
      skill: string | null;
      reason: string;
      gate: number;
      fits: Record<string, number>;
      ms: number;
      /** Recommendation actually shown to the model (onPrompt: injected; onDemand: returned). */
      shown: boolean;
      error?: string;
    })
  | (Base & { t: "skip"; trigger: Trigger; why: SkipWhy })
  | (Base & { t: "read"; skill: string });

export function logPath(): string {
  return path.join(getAgentDir(), "jev-skill-suggestion", "decisions.jsonl");
}

export function hashPrompt(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Best-effort append; logging must never break a turn. */
export async function appendLog(record: LogRecord, file = logPath()): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // ignore
  }
}

export async function readLog(file = logPath()): Promise<LogRecord[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: LogRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogRecord);
    } catch {
      // skip torn line
    }
  }
  return out;
}

export type Stats = {
  byTrigger: Record<
    Trigger,
    { calls: number; suggested: number; shown: number; used: number; errors: number; p50ms: number; p95ms: number }
  >;
  skips: Partial<Record<SkipWhy, number>>;
  /** Shadow only: turns where Jev picked X / native read something, and how often they agree. */
  shadow: { turns: number; agree: number; jevOnly: number; nativeOnly: number; differ: number };
  /** Skills suggested ≥ 3 times, sorted by lowest use rate. */
  perSkill: Array<{ skill: string; suggested: number; used: number }>;
};

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export function summarize(records: LogRecord[]): Stats {
  const key = (r: Base) => `${r.session}#${r.turn}`;
  const readsByTurn = new Map<string, Set<string>>();
  for (const r of records) {
    if (r.t !== "read") continue;
    const set = readsByTurn.get(key(r)) ?? new Set<string>();
    set.add(r.skill);
    readsByTurn.set(key(r), set);
  }

  const empty = () => ({ calls: 0, suggested: 0, shown: 0, used: 0, errors: 0, p50ms: 0, p95ms: 0 });
  const byTrigger: Stats["byTrigger"] = { onPrompt: empty(), onDemand: empty(), shadow: empty() };
  const ms: Record<Trigger, number[]> = { onPrompt: [], onDemand: [], shadow: [] };
  const skips: Stats["skips"] = {};
  const shadow = { turns: 0, agree: 0, jevOnly: 0, nativeOnly: 0, differ: 0 };
  const perSkill = new Map<string, { suggested: number; used: number }>();

  for (const r of records) {
    if (r.t === "skip") {
      skips[r.why] = (skips[r.why] ?? 0) + 1;
      continue;
    }
    if (r.t !== "suggest") continue;
    const s = byTrigger[r.trigger];
    const reads = readsByTurn.get(key(r)) ?? new Set<string>();
    s.calls++;
    ms[r.trigger].push(r.ms);
    if (r.error) s.errors++;

    if (r.trigger === "shadow") {
      if (r.error) continue;
      shadow.turns++;
      if (r.skill && reads.has(r.skill)) shadow.agree++;
      else if (r.skill && reads.size === 0) shadow.jevOnly++;
      else if (!r.skill && reads.size > 0) shadow.nativeOnly++;
      else if (r.skill) shadow.differ++;
      else shadow.agree++; // both quiet
      continue;
    }

    if (!r.skill) continue;
    s.suggested++;
    if (r.shown) s.shown++;
    const used = reads.has(r.skill);
    if (r.shown && used) s.used++;
    if (r.shown) {
      const p = perSkill.get(r.skill) ?? { suggested: 0, used: 0 };
      p.suggested++;
      if (used) p.used++;
      perSkill.set(r.skill, p);
    }
  }

  for (const t of Object.keys(ms) as Trigger[]) {
    const sorted = ms[t].sort((a, b) => a - b);
    byTrigger[t].p50ms = pct(sorted, 0.5);
    byTrigger[t].p95ms = pct(sorted, 0.95);
  }

  return {
    byTrigger,
    skips,
    shadow,
    perSkill: [...perSkill]
      .filter(([, v]) => v.suggested >= 3)
      .map(([skill, v]) => ({ skill, ...v }))
      .sort((a, b) => a.used / a.suggested - b.used / b.suggested || b.suggested - a.suggested),
  };
}

export function formatStats(s: Stats): string {
  const rate = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
  const lines = ["jev skill suggestion — local stats", ""];
  for (const t of ["onPrompt", "onDemand"] as const) {
    const x = s.byTrigger[t];
    if (!x.calls) continue;
    lines.push(
      `${t}: ${x.calls} calls, ${x.suggested} suggested, ${x.shown} shown, used ${x.used}/${x.shown} (${rate(x.used, x.shown)}), ` +
        `${x.errors} errors, p50 ${x.p50ms}ms / p95 ${x.p95ms}ms`,
    );
  }
  const sh = s.shadow;
  if (s.byTrigger.shadow.calls) {
    lines.push(
      `shadow: ${sh.turns} turns, agree ${sh.agree} (${rate(sh.agree, sh.turns)}), Jev-only ${sh.jevOnly}, ` +
        `native-only ${sh.nativeOnly}, differ ${sh.differ}; p50 ${s.byTrigger.shadow.p50ms}ms`,
    );
  }
  const skips = Object.entries(s.skips).map(([k, v]) => `${k} ${v}`);
  if (skips.length) lines.push(`skipped (no Jev call): ${skips.join(", ")}`);
  if (s.perSkill.length) {
    lines.push("", "least-used suggestions (≥3 shown):");
    for (const p of s.perSkill.slice(0, 10)) {
      lines.push(`  ${p.skill}: used ${p.used}/${p.suggested} (${rate(p.used, p.suggested)})`);
    }
  }
  if (lines.length === 2) lines.push("no decisions logged yet");
  return lines.join("\n");
}
