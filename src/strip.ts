import type { Triggers } from "./config.ts";

/** Remove Pi's inlined `<available_skills>` block from a system prompt. */
export function stripAvailableSkills(prompt: string): string {
  return prompt
    .replace(
      /\n*The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/,
      "",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

const ON_DEMAND_GUIDANCE = `
## Skills

Skills are not listed in this prompt. When a task may need a specialized skill workflow, call the \`skill_suggest\` tool with the task. If it returns a skill, read that skill's file and follow it. If it returns none, continue without a skill.
`.trim();

const ON_PROMPT_GUIDANCE = `
## Skills

Skills are not listed in this prompt. When a specialized skill fits the latest user request, a skill recommendation message is injected for this turn. If one is present, read that skill's file and follow it. If none is present, continue without a skill.
`.trim();

const BOTH_GUIDANCE = `
## Skills

Skills are not listed in this prompt. When a specialized skill fits the latest user request, a skill recommendation message is injected for this turn. If one is present, read that skill's file and follow it. Call the \`skill_suggest\` tool only when a new sub-task comes up that differs from the user's request and may need a specialized skill workflow.
`.trim();

export function skillGuidance(t: Triggers): string {
  if (t.onPrompt && t.onDemand) return BOTH_GUIDANCE;
  return t.onPrompt ? ON_PROMPT_GUIDANCE : ON_DEMAND_GUIDANCE;
}

export function formatAutoSuggestion(result: {
  skill: string | null;
  location: string | null;
  reason: string;
}): string | null {
  if (!result.skill || !result.location) return null;
  return [
    "Skill recommendation for this turn:",
    `- skill: ${result.skill}`,
    `- location: ${result.location}`,
    `- reason: ${result.reason}`,
    `Read ${result.location} and follow it. Ignore this if it does not fit the user's request.`,
  ].join("\n");
}
