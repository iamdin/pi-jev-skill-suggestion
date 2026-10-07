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

// Acks / go-aheads: whatever skill the work needs is already in play.
const TRIVIAL =
  /^(ok(ay)?|k|kk|y(es|ep)?|no?|sure|thanks?( you)?|thx|ty|lgtm|nice|great|cool|continue|go( on| ahead)?|proceed|do it|👍|好的?|好吧|嗯+|行|可以|对|是的?|谢谢|多谢|收到|继续|没问题)[\s!.,。！，~～]*$/i;

/** Prompt that never needs a fresh skill route (saves a Jev call). */
export function isTrivialPrompt(prompt: string): boolean {
  return TRIVIAL.test(prompt.trim());
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
