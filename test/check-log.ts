import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENTRY_TYPE, recordsFromEntries, recordsFromSessionDir, summarize, type LogRecord } from "../src/log.ts";
import { isTrivialPrompt } from "../src/strip.ts";

for (const p of ["ok", "OK!", "thanks", "继续", "好的。", "lgtm", "  go ahead  "]) assert.ok(isTrivialPrompt(p), p);
for (const p of ["ok, now make it a pptx", "做个 PPT", "continue with the xlsx export", "review this diff"]) {
  assert.equal(isTrivialPrompt(p), false, p);
}

const at = (session: string, turn: number) => ({ turn: `${session}${turn}` });
const sug = (session: string, turn: number, trigger: "onPrompt" | "onDemand" | "shadow", skill: string | null, shown: boolean, ms = 100): LogRecord => ({
  t: "suggest", ...at(session, turn), trigger, prompt: "h", promptChars: 1, roster: 50,
  skill, reason: "", gate: 0.5, fits: {}, ms, shown,
});
const read = (session: string, turn: number, skill: string): LogRecord => ({ t: "read", ...at(session, turn), skill });

const records: LogRecord[] = [
  // onPrompt: pptx shown 3×, used once; xlsx shown & used; one quiet; one error
  sug("a", 1, "onPrompt", "pptx", true), read("a", 1, "pptx"),
  sug("a", 2, "onPrompt", "pptx", true),
  sug("a", 3, "onPrompt", "pptx", true), read("a", 4, "pptx"), // read in a later turn doesn't count
  sug("a", 5, "onPrompt", "xlsx", true, 300), read("a", 5, "xlsx"),
  sug("a", 6, "onPrompt", null, false),
  { ...sug("a", 7, "onPrompt", null, false), error: "401" },
  { t: "skip", ...at("a", 8), trigger: "onPrompt", why: "trivial" },
  // onDemand
  sug("b", 1, "onDemand", "docx", true), read("b", 1, "docx"),
  // shadow: agree, Jev-only, native-only, differ, both quiet
  sug("c", 1, "shadow", "pptx", false), read("c", 1, "pptx"),
  sug("c", 2, "shadow", "pptx", false),
  sug("c", 3, "shadow", null, false), read("c", 3, "docx"),
  sug("c", 4, "shadow", "pptx", false), read("c", 4, "docx"),
  sug("c", 5, "shadow", null, false),
];

const s = summarize(records);
assert.deepEqual(
  { ...s.byTrigger.onPrompt, p50ms: 0, p95ms: 0 },
  { calls: 6, suggested: 4, shown: 4, used: 2, errors: 1, p50ms: 0, p95ms: 0 },
);
assert.equal(s.byTrigger.onPrompt.p95ms, 300);
assert.equal(s.byTrigger.onDemand.used, 1);
assert.deepEqual(s.skips, { trivial: 1 });
assert.deepEqual(s.shadow, { turns: 5, agree: 2, jevOnly: 1, nativeOnly: 1, differ: 1 });
assert.deepEqual(s.perSkill, [{ skill: "pptx", suggested: 3, used: 1 }]);

// Records round-trip through session custom entries; other entries are ignored.
const entry = (data: LogRecord) => ({ type: "custom", customType: ENTRY_TYPE, data });
const sessionLines = [
  { type: "session", id: "s" },
  entry(records[0]!),
  { type: "custom", customType: "someone-else", data: { t: "suggest" } },
  { type: "message", message: { role: "user", content: "hi" } },
  entry(records[1]!),
];
assert.deepEqual(recordsFromEntries(sessionLines), [records[0], records[1]]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-sessions-"));
try {
  fs.mkdirSync(path.join(dir, "--repo-a--"));
  fs.mkdirSync(path.join(dir, "--repo-b--"));
  fs.writeFileSync(
    path.join(dir, "--repo-a--", "1.jsonl"),
    `${sessionLines.map((l) => JSON.stringify(l)).join("\n")}\n{torn ${ENTRY_TYPE}\n`,
  );
  fs.writeFileSync(path.join(dir, "--repo-b--", "2.jsonl"), `${JSON.stringify(entry(records[2]!))}\n`);
  fs.writeFileSync(path.join(dir, "--repo-b--", "3.jsonl"), `${JSON.stringify({ type: "session" })}\n`);
  const all = await recordsFromSessionDir(dir);
  assert.equal(all.sessions, 2);
  assert.equal(all.records.length, 3);
  assert.equal((await recordsFromSessionDir(path.join(dir, "--repo-b--"))).records.length, 1);
  assert.deepEqual(await recordsFromSessionDir(path.join(dir, "missing")), { sessions: 0, records: [] });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("log + stats + trivial filter ok");
