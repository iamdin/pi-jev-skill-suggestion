import assert from "node:assert/strict";
import { buildContextEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { skillsInContext } from "../src/history.ts";

let n = 0;
const chain: SessionEntry[] = [];
function add(entry: Record<string, unknown>): string {
  const id = `e${++n}`;
  chain.push({ id, parentId: chain.at(-1)?.id ?? null, timestamp: "", ...entry } as SessionEntry);
  return id;
}
const user = (text: string) => add({ type: "message", message: { role: "user", content: text } });
const read = (p: string, isError = false) => {
  const id = `t${n}`;
  add({
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: p } }] },
  });
  add({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "read", content: [], isError } });
};

user("make slides");
read("/skills/pptx/SKILL.md");
user(`<skill name="review" location="/skills/review/SKILL.md">\nbody\n</skill>`);
read("skills/local/SKILL.md"); // relative → resolved against cwd
read("/skills/missing/SKILL.md", true); // failed read doesn't count

let seen = skillsInContext(buildContextEntries(chain), "/repo");
assert.ok(seen.has("/skills/pptx/SKILL.md"));
assert.ok(seen.has("/skills/review/SKILL.md"));
assert.ok(seen.has("/repo/skills/local/SKILL.md"));
assert.equal(seen.has("/skills/missing/SKILL.md"), false);

// Compact: everything before `kept` is summarized away.
const kept = user("now edit the deck");
read("/skills/pptx-edit/SKILL.md");
add({ type: "compaction", summary: "…", firstKeptEntryId: kept, tokensBefore: 1 });

seen = skillsInContext(buildContextEntries(chain), "/repo");
assert.equal(seen.has("/skills/pptx/SKILL.md"), false);
assert.equal(seen.has("/skills/review/SKILL.md"), false);
assert.ok(seen.has("/skills/pptx-edit/SKILL.md"));

console.log("history: compaction-aware skill reads ok");
