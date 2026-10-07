import os from "node:os";
import path from "node:path";
import { parseSkillBlock, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Skill files still visible to the model: `read` tool calls and `/skill:` expansions
 * in the active context. Pass `sessionManager.buildContextEntries()` — it is
 * compaction- and branch-aware, so a skill read before `/compact` (and summarized
 * away) or on another branch no longer counts.
 */
export function skillsInContext(entries: SessionEntry[], cwd: string): Set<string> {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type !== "toolCall" || part.name !== "read") continue;
        const raw = part.arguments?.path;
        if (typeof raw !== "string") continue;
        seen.add(path.resolve(cwd, raw.replace(/^~(?=\/|$)/, os.homedir())));
      }
    } else if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      const block = parseSkillBlock(text);
      if (block) seen.add(block.location);
    }
  }
  return seen;
}
