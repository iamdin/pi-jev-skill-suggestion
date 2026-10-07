/**
 * pi-jev-skill-suggestion
 *
 * Load: pi -e ./index.ts   or   pi install .
 *
 * Strips <available_skills>, then routes with Jev on either or both triggers:
 * - onPrompt: extension suggests after each user prompt
 * - onDemand: model calls skill_suggest
 */

import path from "node:path";
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
import { resolveReadPath, skillsInContext } from "./src/history.ts";
import {
  ENTRY_TYPE,
  formatStats,
  hashPrompt,
  newTurnId,
  recordsFromEntries,
  recordsFromSessionDir,
  summarize,
  type LogRecord,
  type SkipWhy,
  type Trigger,
} from "./src/log.ts";
import { none, suggest, type RosterSkill, type Suggestion } from "./src/router.ts";
import { formatAutoSuggestion, isTrivialPrompt, skillGuidance, stripAvailableSkills } from "./src/strip.ts";

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
  let shadow = false;
  let logging = true;
  let passthrough = false; // off, shadow, or small roster: Pi's own listing stays
  let turn = newTurnId();
  let inputSource: string | undefined;
  /** Shadow routes run off the critical path; flushed on shutdown so `pi -p` doesn't drop them. */
  const pending = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    const done = p.catch(() => {}).finally(() => pending.delete(done));
    pending.add(done);
  };

  /** Record into the current Pi session (custom entry, not sent to the LLM). */
  function record(rec: LogRecord) {
    if (!logging) return;
    try {
      pi.appendEntry(ENTRY_TYPE, rec);
    } catch {
      // session torn down — drop
    }
  }

  function skipWhy(prompt: string): SkipWhy | null {
    if (parseSkillBlock(prompt)) return "explicit-skill"; // `/skill:name` arrives expanded
    if (inputSource === "extension") return "extension-input"; // not typed by a human
    if (isTrivialPrompt(prompt)) return "trivial";
    return null;
  }

  async function route(
    trigger: Trigger,
    request: string,
    signal?: AbortSignal,
  ): Promise<{ result: Suggestion; log: (shown: boolean) => void }> {
    const t0 = performance.now();
    const at = turn; // shadow may finish after the next prompt starts
    const write = (result: Suggestion, shown: boolean, error?: string) =>
      record({
        t: "suggest",
        turn: at,
        trigger,
        prompt: hashPrompt(request),
        promptChars: request.length,
        roster: roster.length,
        skill: result.skill,
        reason: result.reason,
        gate: result.gate,
        fits: result.fits,
        ms: Math.round(performance.now() - t0),
        shown,
        ...(error ? { error } : {}),
      });
    try {
      const result = await suggest(client, request, roster, { signal, shortlistSize });
      return { result, log: (shown) => write(result, shown) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write(none("error"), false, message);
      throw err;
    }
  }

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
    saveConfig({ ...next, shortlistSize, minSkillsToRoute, shadow, log: logging });
  }

  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadConfig(ctx.cwd);
    if (loaded) {
      shortlistSize = loaded.config.shortlistSize;
      minSkillsToRoute = loaded.config.minSkillsToRoute;
      shadow = loaded.config.shadow;
      logging = loaded.config.log;
      applyTriggers(loaded.config);
      const where = loaded.source === "env" ? `${ON_PROMPT_ENV} / ${ON_DEMAND_ENV}` : loaded.source;
      const what = shadow ? "shadow (log only, Pi listing kept)" : describeTriggers(loaded.config);
      ctx.ui.notify(`jev skill suggestion: ${what} (${where})`, "info");
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

  pi.registerCommand("jev-skill-stats", {
    description: "Skill-suggestion stats from session records: (empty) this session · project · all",
    getArgumentCompletions: (prefix) =>
      ["project", "all"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
    async handler(args, ctx) {
      const scope = args.trim() || "session";
      let records: LogRecord[];
      let where: string;
      if (scope === "session") {
        records = recordsFromEntries(ctx.sessionManager.getEntries());
        where = "this session";
      } else if (scope === "project" || scope === "all") {
        const projectDir = ctx.sessionManager.getSessionDir();
        const dir = scope === "all" ? path.dirname(projectDir) : projectDir; // sessions root / this cwd
        const found = await recordsFromSessionDir(dir);
        records = found.records;
        where = `${found.sessions} sessions in ${dir}`;
      } else {
        ctx.ui.notify("usage: /jev-skill-stats [project|all]", "warning");
        return;
      }
      ctx.ui.notify(`${formatStats(summarize(records))}\n\n(${where})`, "info");
    },
  });

  pi.on("session_shutdown", async () => {
    await Promise.allSettled([...pending]);
  });

  pi.on("input", async (event) => {
    inputSource = event.source;
  });

  // Every successful read of a roster skill: "was the suggestion used?" / native pick in shadow.
  pi.on("tool_result", async (event, ctx) => {
    if (!logging || event.toolName !== "read" || event.isError) return;
    const raw = event.input.path;
    if (typeof raw !== "string") return;
    const location = resolveReadPath(raw, ctx.cwd);
    const skill = roster.find((s) => s.filePath === location);
    if (skill) record({ t: "read", turn, skill: skill.name });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    roster = toRoster(event.systemPromptOptions.skills);
    turn = newTurnId();
    const off = !triggers.onPrompt && !triggers.onDemand;
    const next = shadow || off || roster.length < minSkillsToRoute; // small roster: listing is cheap enough
    if (next !== passthrough) {
      passthrough = next;
      syncTools();
    }

    if (shadow) {
      // Pi keeps its listing; Jev runs off the critical path and is only logged.
      const why = skipWhy(event.prompt);
      if (why) record({ t: "skip", turn, trigger: "shadow", why });
      else if (roster.length) track(route("shadow", event.prompt).then((r) => r.log(false)));
      return;
    }
    if (passthrough) return;

    const stripped = stripAvailableSkills(event.systemPrompt);
    const systemPrompt = `${stripped}\n\n${skillGuidance(triggers)}`;
    if (!triggers.onPrompt) return { systemPrompt };

    const why = skipWhy(event.prompt);
    if (why) {
      record({ t: "skip", turn, trigger: "onPrompt", why });
      return { systemPrompt };
    }

    try {
      const { result, log } = await route("onPrompt", event.prompt);
      const loaded = skillsInContext(ctx.sessionManager.buildContextEntries(), ctx.cwd);
      const content =
        result.location && loaded.has(result.location) ? null : formatAutoSuggestion(result);
      log(!!content);
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
        const { result, log } = await route("onDemand", params.task, signal);
        log(!!result.skill);
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
