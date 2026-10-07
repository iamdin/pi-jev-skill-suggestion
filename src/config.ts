import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** When Jev routes. Both may be on; both off = extension off. */
export type Triggers = {
  /** Suggest a skill on every user prompt (before the agent starts). */
  onPrompt: boolean;
  /** Expose `skill_suggest` so the model can ask when it needs a skill. */
  onDemand: boolean;
};

export type ExtensionConfig = Triggers & {
  /** Max stage-1 candidates sent to stage-2 rerank. */
  shortlistSize: number;
  /** Below this many skills, leave Pi's listing alone and skip Jev. 0 = always route. */
  minSkillsToRoute: number;
  /** Keep Pi's native listing; route every prompt in the background and only log. */
  shadow: boolean;
  /** Append decisions to the local JSONL log. */
  log: boolean;
};

const FILENAME = "jev-skill-suggestion.json";
export const ON_PROMPT_ENV = "JEV_SKILL_ON_PROMPT";
export const ON_DEMAND_ENV = "JEV_SKILL_ON_DEMAND";
export const DEFAULT_SHORTLIST_SIZE = 3;
export const MAX_SHORTLIST_SIZE = 32;
export const DEFAULT_MIN_SKILLS_TO_ROUTE = 20;

export function globalConfigPath(): string {
  return join(getAgentDir(), FILENAME);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, FILENAME);
}

export function describeTriggers(t: Triggers): string {
  const on = [t.onPrompt && "onPrompt", t.onDemand && "onDemand"].filter(Boolean);
  return on.length ? on.join(" + ") : "off";
}

export function clampShortlistSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SHORTLIST_SIZE;
  return Math.min(MAX_SHORTLIST_SIZE, Math.max(1, Math.trunc(value)));
}

export function clampMinSkillsToRoute(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MIN_SKILLS_TO_ROUTE;
  return Math.max(0, Math.trunc(value));
}

function envFlag(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined;
}

/** Per-trigger env overrides; unset/unknown values are left out. */
export function triggersFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Triggers> {
  const out: Partial<Triggers> = {};
  const onPrompt = envFlag(env[ON_PROMPT_ENV]);
  const onDemand = envFlag(env[ON_DEMAND_ENV]);
  if (onPrompt !== undefined) out.onPrompt = onPrompt;
  if (onDemand !== undefined) out.onDemand = onDemand;
  return out;
}

function readConfigFile(path: string): ExtensionConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      onPrompt?: unknown;
      onDemand?: unknown;
      mode?: unknown; // 0.1.x: "tool" | "auto"
      shortlistSize?: unknown;
      minSkillsToRoute?: unknown;
      shadow?: unknown;
      log?: unknown;
    };
    let triggers: Triggers;
    if (typeof raw.onPrompt === "boolean" || typeof raw.onDemand === "boolean") {
      triggers = { onPrompt: raw.onPrompt === true, onDemand: raw.onDemand === true };
    } else if (raw.mode === "tool" || raw.mode === "auto") {
      triggers = { onPrompt: raw.mode === "auto", onDemand: raw.mode === "tool" };
    } else {
      return null;
    }
    return {
      ...triggers,
      shortlistSize: clampShortlistSize(raw.shortlistSize),
      minSkillsToRoute: clampMinSkillsToRoute(raw.minSkillsToRoute),
      shadow: raw.shadow === true,
      log: raw.log !== false,
    };
  } catch {
    return null;
  }
}

function readFileConfig(cwd?: string): { config: ExtensionConfig; source: "project" | "global" } | null {
  if (cwd) {
    const project = readConfigFile(projectConfigPath(cwd));
    if (project) return { config: project, source: "project" };
  }
  const global = readConfigFile(globalConfigPath());
  if (global) return { config: global, source: "global" };
  return null;
}

/**
 * Resolve config: `JEV_SKILL_ON_PROMPT` / `JEV_SKILL_ON_DEMAND` override their trigger only;
 * everything else comes from project/global JSON (else default; a trigger with no file is off).
 */
export function loadConfig(cwd?: string): { config: ExtensionConfig; source: "env" | "project" | "global" } | null {
  const file = readFileConfig(cwd);
  const fromEnv = triggersFromEnv();
  if (Object.keys(fromEnv).length === 0) return file;
  return {
    config: {
      onPrompt: false,
      onDemand: false,
      shortlistSize: DEFAULT_SHORTLIST_SIZE,
      minSkillsToRoute: DEFAULT_MIN_SKILLS_TO_ROUTE,
      shadow: false,
      log: true,
      ...file?.config,
      ...fromEnv,
    },
    source: "env",
  };
}

/** Writes global user config (`~/.pi/agent/jev-skill-suggestion.json`). */
export function saveConfig(config: ExtensionConfig): void {
  const path = globalConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        onPrompt: config.onPrompt,
        onDemand: config.onDemand,
        shortlistSize: clampShortlistSize(config.shortlistSize),
        minSkillsToRoute: clampMinSkillsToRoute(config.minSkillsToRoute),
        shadow: config.shadow,
        log: config.log,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
