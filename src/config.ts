import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type SuggestMode = "tool" | "auto";

export type ExtensionConfig = {
  mode: SuggestMode;
};

const FILENAME = "jev-skill-suggestion.json";
export const MODE_ENV = "JEV_SKILL_MODE";

export function globalConfigPath(): string {
  return join(getAgentDir(), FILENAME);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, FILENAME);
}

/** Prefer project `.pi/…`, then global `~/.pi/agent/…`. */
export function resolveConfigPath(cwd?: string): string {
  if (cwd) {
    const project = projectConfigPath(cwd);
    if (existsSync(project)) return project;
  }
  return globalConfigPath();
}

export function isSuggestMode(value: unknown): value is SuggestMode {
  return value === "tool" || value === "auto";
}

export function modeFromEnv(env: NodeJS.ProcessEnv = process.env): SuggestMode | null {
  const raw = env[MODE_ENV]?.trim().toLowerCase();
  return isSuggestMode(raw) ? raw : null;
}

function readConfigFile(path: string): ExtensionConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { mode?: unknown };
    if (!isSuggestMode(raw.mode)) return null;
    return { mode: raw.mode };
  } catch {
    return null;
  }
}

/**
 * Resolve mode: env `JEV_SKILL_MODE` → project `.pi/…` → global `~/.pi/agent/…`.
 * Returns `source` so callers can skip first-run prompts when env wins.
 */
export function loadConfig(cwd?: string): { config: ExtensionConfig; source: "env" | "project" | "global" } | null {
  const fromEnv = modeFromEnv();
  if (fromEnv) return { config: { mode: fromEnv }, source: "env" };

  if (cwd) {
    const project = readConfigFile(projectConfigPath(cwd));
    if (project) return { config: project, source: "project" };
  }

  const global = readConfigFile(globalConfigPath());
  if (global) return { config: global, source: "global" };
  return null;
}

/** Writes global user config (`~/.pi/agent/jev-skill-suggestion.json`). */
export function saveConfig(config: ExtensionConfig): void {
  const path = globalConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
