/**
 * pi-jev-skill-suggestion
 *
 * Load: pi -e ./index.ts   or   pi install .
 *
 * Strips <available_skills>, then routes with Jev on either or both triggers:
 * - onPrompt: extension suggests after each user prompt
 * - onDemand: model calls skill_suggest
 */

import { parseSkillBlock, type ExtensionAPI, type Skill } from "@earendil-works/pi-coding-agent";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Type } from "typebox";
import {
  DEFAULT_MIN_SKILLS_TO_ROUTE,
  DEFAULT_SHORTLIST_SIZE,
  describeTriggers,
  globalConfigPath,
  loadConfig,
  ON_DEMAND_ENV,
  ON_PROMPT_ENV,
  saveConfig,
  triggersFromEnv,
  type Triggers,
} from "./src/config.ts";
import { skillsInContext } from "./src/history.ts";
import { none, suggest, type RosterSkill } from "./src/router.ts";
import { formatAutoSuggestion, skillGuidance, stripAvailableSkills } from "./src/strip.ts";

const TRIGGER_OPTIONS: Array<[string, Triggers]> = [
  ["onDemand — model calls skill_suggest when it needs a skill", { onPrompt: false, onDemand: true }],
  ["onPrompt — suggest a skill on every user prompt", { onPrompt: true, onDemand: false }],
  ["onPrompt + onDemand — both", { onPrompt: true, onDemand: true }],
  ["off — keep Pi's normal skill listing", { onPrompt: false, onDemand: false }],
];

function toRoster(skills: Skill[] | undefined): RosterSkill[] {
  return (skills ?? [])
    .filter((s) => !s.disableModelInvocation)
    .map((s) => ({ name: s.name, description: s.description, filePath: s.filePath }));
}

function formatToolResult(result: Awaited<ReturnType<typeof suggest>>, alreadyRead = false): string {
  if (!result.skill) {
    return JSON.stringify({ skill: null, reason: result.reason }, null, 2);
  }
  return JSON.stringify(
    {
      skill: result.skill,
      location: result.location,
      reason: result.reason,
      next: alreadyRead
        ? `Already read and still in context; follow it.`
        : `Read ${result.location} and follow it.`,
    },
    null,
    2,
  );
}

async function chooseTriggers(
  select: (title: string, options: string[]) => Promise<string | undefined>,
): Promise<Triggers | null> {
  const choice = await select(
    "jev skill suggestion — when to suggest",
    TRIGGER_OPTIONS.map(([label]) => label),
  );
  return TRIGGER_OPTIONS.find(([label]) => label === choice)?.[1] ?? null;
}

export default function (pi: ExtensionAPI) {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim() ?? "";
  if (!apiKey) return; // leave Pi's skill listing alone

  const client = new TypeSafeClient({ apiKey });
  let roster: RosterSkill[] = [];
  let triggers: Triggers = { onPrompt: false, onDemand: true };
  let shortlistSize = DEFAULT_SHORTLIST_SIZE;
  let minSkillsToRoute = DEFAULT_MIN_SKILLS_TO_ROUTE;
  let passthrough = false; // off or small roster: Pi's own listing stays, no routing

  function syncTools() {
    const tools = pi.getActiveTools().filter((name) => name !== "skill_suggest");
    if (triggers.onDemand && !passthrough) tools.push("skill_suggest");
    pi.setActiveTools(tools);
  }

  function applyTriggers(next: Triggers) {
    triggers = next;
    syncTools();
  }

  function persist(next: Triggers) {
    saveConfig({ ...next, shortlistSize, minSkillsToRoute });
  }

  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadConfig(ctx.cwd);
    if (loaded) {
      shortlistSize = loaded.config.shortlistSize;
      minSkillsToRoute = loaded.config.minSkillsToRoute;
      applyTriggers(loaded.config);
      const where = loaded.source === "env" ? `${ON_PROMPT_ENV} / ${ON_DEMAND_ENV}` : loaded.source;
      ctx.ui.notify(`jev skill suggestion: ${describeTriggers(loaded.config)} (${where})`, "info");
      return;
    }
    const picked = await chooseTriggers((title, options) => ctx.ui.select(title, options));
    if (!picked) {
      applyTriggers({ onPrompt: false, onDemand: true });
      ctx.ui.notify("jev skill suggestion: nothing chosen; defaulting to onDemand", "warning");
      return;
    }
    applyTriggers(picked);
    persist(picked);
    ctx.ui.notify(`jev skill suggestion: saved ${describeTriggers(picked)} → ${globalConfigPath()}`, "info");
  });

  pi.registerCommand("jev-skill-suggestion", {
    description: "Choose when Jev suggests skills (onPrompt / onDemand / both / off)",
    async handler(_args, ctx) {
      const picked = await chooseTriggers((title, options) => ctx.ui.select(title, options));
      if (!picked) {
        ctx.ui.notify("cancelled", "info");
        return;
      }
      applyTriggers(picked);
      persist(picked);
      const saved = `saved ${describeTriggers(picked)} → ${globalConfigPath()}`;
      if (Object.keys(triggersFromEnv()).length) {
        ctx.ui.notify(`${saved} (${ON_PROMPT_ENV} / ${ON_DEMAND_ENV} still override next session)`, "warning");
        return;
      }
      ctx.ui.notify(saved, "info");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    roster = toRoster(event.systemPromptOptions.skills);
    const off = !triggers.onPrompt && !triggers.onDemand;
    const next = off || roster.length < minSkillsToRoute; // small roster: listing is cheap enough
    if (next !== passthrough) {
      passthrough = next;
      syncTools();
    }
    if (passthrough) return;

    const stripped = stripAvailableSkills(event.systemPrompt);
    const systemPrompt = `${stripped}\n\n${skillGuidance(triggers)}`;

    // `/skill:name` arrives expanded — the user already picked; don't route.
    if (!triggers.onPrompt || parseSkillBlock(event.prompt)) {
      return { systemPrompt };
    }

    try {
      const result = await suggest(client, event.prompt, roster, { shortlistSize });
      const loaded = skillsInContext(ctx.sessionManager.buildContextEntries(), ctx.cwd);
      if (result.location && loaded.has(result.location)) return { systemPrompt };
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await suggest(client, params.task, roster, { signal, shortlistSize });
        const loaded = skillsInContext(ctx.sessionManager.buildContextEntries(), ctx.cwd);
        return {
          content: [
            {
              type: "text",
              text: formatToolResult(result, !!result.location && loaded.has(result.location)),
            },
          ],
          details: { ok: true, ...result },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: formatToolResult(none(`routing failed open: ${message}`)) }],
          details: { ok: false, reason: message },
        };
      }
    },
  });
}
