import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clampMinSkillsToRoute,
  clampShortlistSize,
  DEFAULT_MIN_SKILLS_TO_ROUTE,
  DEFAULT_SHORTLIST_SIZE,
  describeTriggers,
  loadConfig,
  triggersFromEnv,
} from "../src/config.ts";
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

const onDemand = { onPrompt: false, onDemand: true };
const onPrompt = { onPrompt: true, onDemand: false };
const both = { onPrompt: true, onDemand: true };
assert.match(skillGuidance(onDemand), /skill_suggest/);
assert.doesNotMatch(skillGuidance(onPrompt), /skill_suggest/);
assert.match(skillGuidance(onPrompt), /recommendation message/);
assert.match(skillGuidance(both), /recommendation message/);
assert.match(skillGuidance(both), /skill_suggest/);
assert.equal(describeTriggers(both), "onPrompt + onDemand");
assert.equal(describeTriggers({ onPrompt: false, onDemand: false }), "off");

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

assert.deepEqual(triggersFromEnv({ JEV_SKILL_ON_PROMPT: "1", JEV_SKILL_ON_DEMAND: "FALSE" }), {
  onPrompt: true,
  onDemand: false,
});
assert.deepEqual(triggersFromEnv({ JEV_SKILL_ON_PROMPT: "nope" }), {});
assert.deepEqual(triggersFromEnv({}), {});

const ENV_KEYS = ["JEV_SKILL_ON_PROMPT", "JEV_SKILL_ON_DEMAND"] as const;
const prevEnv = ENV_KEYS.map((k) => process.env[k]);
const projectRoot = mkdtempSync(join(tmpdir(), "jev-skill-project-"));
const writeProject = (config: object) =>
  writeFileSync(join(projectRoot, ".pi", "jev-skill-suggestion.json"), `${JSON.stringify(config)}\n`);
try {
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  for (const k of ENV_KEYS) delete process.env[k];

  writeProject({ onPrompt: true, onDemand: true, shortlistSize: 9, minSkillsToRoute: 0 });
  const fromProject = loadConfig(projectRoot);
  assert.equal(fromProject?.source, "project");
  assert.equal(fromProject?.config.onPrompt, true);
  assert.equal(fromProject?.config.onDemand, true);
  assert.equal(fromProject?.config.shortlistSize, 9);
  assert.equal(fromProject?.config.minSkillsToRoute, 0);

  process.env.JEV_SKILL_ON_DEMAND = "0";
  const fromEnv = loadConfig(projectRoot);
  assert.equal(fromEnv?.source, "env");
  assert.equal(fromEnv?.config.onPrompt, true); // untouched by env
  assert.equal(fromEnv?.config.onDemand, false);
  assert.equal(fromEnv?.config.shortlistSize, 9);
  delete process.env.JEV_SKILL_ON_DEMAND;

  // 0.1.x configs still load.
  writeProject({ mode: "auto" });
  assert.deepEqual(
    [loadConfig(projectRoot)?.config.onPrompt, loadConfig(projectRoot)?.config.onDemand],
    [true, false],
  );
  writeProject({ mode: "tool" });
  assert.deepEqual(
    [loadConfig(projectRoot)?.config.onPrompt, loadConfig(projectRoot)?.config.onDemand],
    [false, true],
  );

  assert.equal(clampShortlistSize(undefined), DEFAULT_SHORTLIST_SIZE);
  assert.equal(clampShortlistSize(0), 1);
  assert.equal(clampShortlistSize(99), 32);
  assert.equal(clampShortlistSize(4.8), 4);
  assert.equal(clampMinSkillsToRoute(undefined), DEFAULT_MIN_SKILLS_TO_ROUTE);
  assert.equal(clampMinSkillsToRoute(-5), 0);
  assert.equal(clampMinSkillsToRoute(12.7), 12);
} finally {
  ENV_KEYS.forEach((k, i) => {
    if (prevEnv[i] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[i];
  });
  rmSync(projectRoot, { recursive: true, force: true });
}

console.log("strip + triggers config ok");
