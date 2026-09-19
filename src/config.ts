import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type SuggestMode = "tool" | "auto";

export type ExtensionConfig = {
  mode: SuggestMode;
  /** Max stage-1 candidates sent to stage-2 rerank. */
  shortlistSize: number;
};

const FILENAME = "jev-skill-suggestion.json";
export const MODE_ENV = "JEV_SKILL_MODE";
export const DEFAULT_SHORTLIST_SIZE = 3;
export const MAX_SHORTLIST_SIZE = 32;

export function globalConfigPath(): string {
  return join(getAgentDir(), FILENAME);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, FILENAME);
}

export function isSuggestMode(value: unknown): value is SuggestMode {
  return value === "tool" || value === "auto";
}

export function clampShortlistSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SHORTLIST_SIZE;
  return Math.min(MAX_SHORTLIST_SIZE, Math.max(1, Math.trunc(value)));
}

export function modeFromEnv(env: NodeJS.ProcessEnv = process.env): SuggestMode | null {
  const raw = env[MODE_ENV]?.trim().toLowerCase();
  return isSuggestMode(raw) ? raw : null;
}

function readConfigFile(path: string): ExtensionConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { mode?: unknown; shortlistSize?: unknown };
    if (!isSuggestMode(raw.mode)) return null;
    return { mode: raw.mode, shortlistSize: clampShortlistSize(raw.shortlistSize) };
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
 * Resolve config: env `JEV_SKILL_MODE` overrides mode only;
 * `shortlistSize` still comes from project/global JSON (else default).
 */
export function loadConfig(cwd?: string): { config: ExtensionConfig; source: "env" | "project" | "global" } | null {
  const file = readFileConfig(cwd);
  const fromEnv = modeFromEnv();
  if (fromEnv) {
    return {
      config: {
        mode: fromEnv,
        shortlistSize: file?.config.shortlistSize ?? DEFAULT_SHORTLIST_SIZE,
      },
      source: "env",
    };
  }
  return file;
}

/** Writes global user config (`~/.pi/agent/jev-skill-suggestion.json`). */
export function saveConfig(config: ExtensionConfig): void {
  const path = globalConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ mode: config.mode, shortlistSize: clampShortlistSize(config.shortlistSize) }, null, 2)}\n`,
    "utf8",
  );
}
