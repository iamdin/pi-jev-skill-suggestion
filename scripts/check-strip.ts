import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, modeFromEnv } from "../src/config.ts";
import { formatAutoSuggestion, skillGuidance, stripAvailableSkills } from "../src/strip.ts";

const sample = `You are an expert coding assistant.

Available tools:
- read: Read files

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>brave-search</name>
    <description>Search the web</description>
    <location>/tmp/brave/SKILL.md</location>
  </skill>
</available_skills>

Current working directory: /tmp`;

const stripped = stripAvailableSkills(sample);
assert.equal(stripped.includes("<available_skills>"), false);
assert.equal(stripped.includes("brave-search"), false);
assert.equal(stripped.includes("Available tools:"), true);
assert.equal(stripped.includes("Current working directory: /tmp"), true);

assert.match(skillGuidance("tool"), /skill_suggest/);
assert.doesNotMatch(skillGuidance("auto"), /skill_suggest/);
assert.match(skillGuidance("auto"), /recommendation message/);

assert.equal(
  formatAutoSuggestion({ skill: null, location: null, reason: "quiet" }),
  null,
);
assert.match(
  formatAutoSuggestion({
    skill: "pptx",
    location: "/tmp/pptx/SKILL.md",
    reason: "fits",
  }) ?? "",
  /pptx/,
);

assert.equal(modeFromEnv({ JEV_SKILL_MODE: "auto" }), "auto");
assert.equal(modeFromEnv({ JEV_SKILL_MODE: "TOOL" }), "tool");
assert.equal(modeFromEnv({ JEV_SKILL_MODE: "nope" }), null);
assert.equal(modeFromEnv({}), null);

const prevMode = process.env.JEV_SKILL_MODE;
const projectRoot = mkdtempSync(join(tmpdir(), "jev-skill-project-"));
try {
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".pi", "jev-skill-suggestion.json"),
    `${JSON.stringify({ mode: "tool" }, null, 2)}\n`,
  );

  delete process.env.JEV_SKILL_MODE;
  const fromProject = loadConfig(projectRoot);
  assert.equal(fromProject?.source, "project");
  assert.equal(fromProject?.config.mode, "tool");

  process.env.JEV_SKILL_MODE = "auto";
  const fromEnv = loadConfig(projectRoot);
  assert.equal(fromEnv?.source, "env");
  assert.equal(fromEnv?.config.mode, "auto");
} finally {
  if (prevMode === undefined) delete process.env.JEV_SKILL_MODE;
  else process.env.JEV_SKILL_MODE = prevMode;
  rmSync(projectRoot, { recursive: true, force: true });
}

console.log("strip + mode guidance ok");
