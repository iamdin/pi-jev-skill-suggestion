/**
 * pi-jev-skill-suggestion
 *
 * Load: pi -e ./index.ts   or   pi install .
 *
 * Strips <available_skills>, then either:
 * - tool: model calls skill_suggest
 * - auto: extension suggests after each user prompt
 */

import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Type } from "typebox";
import {
  globalConfigPath,
  isSuggestMode,
  loadConfig,
  modeFromEnv,
  saveConfig,
  type SuggestMode,
} from "./src/config.ts";
import { suggest, type RosterSkill } from "./src/router.ts";
import { formatAutoSuggestion, skillGuidance, stripAvailableSkills } from "./src/strip.ts";

const MODE_OPTIONS = [
  "tool — model calls skill_suggest when needed",
  "auto — suggest a skill after each user prompt",
] as const;

function parseModeChoice(choice: string | undefined): SuggestMode | null {
  if (!choice) return null;
  const mode = choice.split(" — ")[0]?.trim();
  return isSuggestMode(mode) ? mode : null;
}

function toRoster(skills: Skill[] | undefined): RosterSkill[] {
  return (skills ?? [])
    .filter((s) => !s.disableModelInvocation)
    .map((s) => ({ name: s.name, description: s.description, filePath: s.filePath }));
}

function formatToolResult(result: Awaited<ReturnType<typeof suggest>>): string {
  if (!result.skill) {
    return JSON.stringify({ skill: null, reason: result.reason }, null, 2);
  }
  return JSON.stringify(
    {
      skill: result.skill,
      location: result.location,
      reason: result.reason,
      next: `Read ${result.location} and follow it.`,
    },
    null,
    2,
  );
}

async function chooseMode(
  select: (title: string, options: string[]) => Promise<string | undefined>,
): Promise<SuggestMode | null> {
  const choice = await select("jev skill suggestion — choose mode", [...MODE_OPTIONS]);
  return parseModeChoice(choice);
}

export default function (pi: ExtensionAPI) {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim() ?? "";
  if (!apiKey) return; // leave Pi's skill listing alone

  const client = new TypeSafeClient({ apiKey });
  let roster: RosterSkill[] = [];
  let mode: SuggestMode | null = null;

  function applyModeTools(next: SuggestMode | null) {
    mode = next;
    const tools = pi.getActiveTools().filter((name) => name !== "skill_suggest");
    if (next !== "auto") tools.push("skill_suggest");
    pi.setActiveTools(tools);
  }

  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadConfig(ctx.cwd);
    if (loaded) {
      applyModeTools(loaded.config.mode);
      const where = loaded.source === "env" ? "JEV_SKILL_MODE" : loaded.source;
      ctx.ui.notify(`jev skill suggestion: ${loaded.config.mode} mode (${where})`, "info");
      return;
    }
    const picked = await chooseMode((title, options) => ctx.ui.select(title, options));
    if (!picked) {
      applyModeTools("tool");
      ctx.ui.notify("jev skill suggestion: no mode chosen; defaulting to tool", "warning");
      return;
    }
    applyModeTools(picked);
    saveConfig({ mode: picked });
    ctx.ui.notify(`jev skill suggestion: saved ${picked} → ${globalConfigPath()}`, "info");
  });

  pi.registerCommand("jev-skill-mode", {
    description: "Choose tool vs auto skill suggestion mode",
    async handler(_args, ctx) {
      const picked = await chooseMode((title, options) => ctx.ui.select(title, options));
      if (!picked) {
        ctx.ui.notify("cancelled", "info");
        return;
      }
      applyModeTools(picked);
      saveConfig({ mode: picked });
      const envMode = modeFromEnv();
      if (envMode) {
        ctx.ui.notify(
          `saved ${picked} → ${globalConfigPath()} (JEV_SKILL_MODE=${envMode} still overrides next session)`,
          "warning",
        );
        return;
      }
      ctx.ui.notify(`saved ${picked} → ${globalConfigPath()}`, "info");
    },
  });

  pi.on("before_agent_start", async (event) => {
    roster = toRoster(event.systemPromptOptions.skills);
    const stripped = stripAvailableSkills(event.systemPrompt);
    const activeMode: SuggestMode = mode ?? "tool";
    const systemPrompt = `${stripped}\n\n${skillGuidance(activeMode)}`;

    if (activeMode !== "auto") {
      return { systemPrompt };
    }

    try {
      const result = await suggest(client, event.prompt, roster);
      const content = formatAutoSuggestion(result);
      if (!content) return { systemPrompt };
      return {
        systemPrompt,
        message: {
          customType: "jev-skill-suggestion",
          content,
          display: true,
          details: result,
        },
      };
    } catch {
      // fail open / quiet
      return { systemPrompt };
    }
  });

  pi.registerTool({
    name: "skill_suggest",
    label: "Skill Suggest",
    description:
      "Suggest which installed skill to load for a task. Returns at most one skill name and file path, or none.",
    promptSnippet: "Suggest which installed skill to load for a task",
    promptGuidelines: [
      "Use skill_suggest when a specialized skill or documented workflow may help and skills are not listed in the system prompt.",
      "If skill_suggest returns a skill, read that skill's file and follow it. If it returns none, continue without a skill.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "The user task or request to route against installed skills" }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const result = await suggest(client, params.task, roster, signal);
        return {
          content: [{ type: "text", text: formatToolResult(result) }],
          details: { ok: true, ...result },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: formatToolResult({
                skill: null,
                location: null,
                reason: `routing failed open: ${message}`,
                gate: 0,
                shortlist: [],
                fits: {},
              }),
            },
          ],
          details: { ok: false, reason: message },
        };
      }
    },
  });
}
