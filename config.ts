import fs from "node:fs";
import path from "node:path";
import { normalizeFolderPath, type ImportTarget } from "./src/targets.js";

// Mirrors the project-root resolution in server.ts: stable across dev
// (tsx running config.ts directly) and prod (compiled dist/config.js).
const PROJECT_ROOT = import.meta.filename.endsWith(".ts")
  ? import.meta.dirname
  : path.join(import.meta.dirname, "..");

const CONFIG_PATH = path.join(PROJECT_ROOT, "mermaid-local-config.json");

export interface MermaidLocalConfig {
  /** Base URL of the Mermaid Local `agent-api.mjs` REST server. */
  agentApiBaseUrl: string;
  /** Where "→ Mermaid Local" puts a diagram; the project is auto-created if it doesn't exist yet. */
  importTarget: ImportTarget;
  /**
   * Per-workspace overrides of `importTarget`, keyed by the session's working
   * directory (see normalizeWorkspace). A workspace without an entry here
   * follows `importTarget`.
   */
  workspaceTargets: Record<string, ImportTarget>;
}

export const DEFAULT_CONFIG: MermaidLocalConfig = {
  agentApiBaseUrl: "http://127.0.0.1:4789",
  importTarget: { project: "LLM", folderPath: "" },
  workspaceTargets: {},
};

/** "/a/b/" -> "/a/b"; blank -> "". Workspaces are compared as these strings. */
export function normalizeWorkspace(workspace: string): string {
  const trimmed = workspace.trim();
  return trimmed.replace(/\/+$/, "") || (trimmed.startsWith("/") ? "/" : "");
}

/** Last path segment, for showing a workspace to people: "/a/b" -> "b". */
export function workspaceLabel(workspace: string): string {
  return workspace.split("/").filter(Boolean).pop() ?? workspace;
}

/** The target a diagram from `workspace` is imported into (null = made without one). */
export function resolveImportTarget(config: MermaidLocalConfig, workspace: string | null): ImportTarget {
  return (workspace && config.workspaceTargets[workspace]) || config.importTarget;
}

/** Sets `workspace`'s own target; with no workspace, the fallback every other workspace follows. */
export function withImportTarget(
  config: MermaidLocalConfig,
  workspace: string | null,
  target: ImportTarget,
): MermaidLocalConfig {
  return workspace
    ? { ...config, workspaceTargets: { ...config.workspaceTargets, [workspace]: target } }
    : { ...config, importTarget: target };
}

function parseImportTarget(raw: unknown): ImportTarget | null {
  const { project, folderPath } = (raw ?? {}) as { project?: unknown; folderPath?: unknown };
  const name = typeof project === "string" ? project.trim() : "";
  if (!name) return null;
  return { project: name, folderPath: typeof folderPath === "string" ? normalizeFolderPath(folderPath) : "" };
}

/** Reads the config file, falling back to DEFAULT_CONFIG for a missing file or any invalid field. */
export function loadConfig(configPath = CONFIG_PATH): MermaidLocalConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return DEFAULT_CONFIG;
  }
  const { agentApiBaseUrl, importTarget, workspaceTargets } = (raw ?? {}) as {
    agentApiBaseUrl?: unknown;
    importTarget?: unknown;
    workspaceTargets?: unknown;
  };
  const perWorkspace: Record<string, ImportTarget> = {};
  const entries = workspaceTargets && typeof workspaceTargets === "object" ? Object.entries(workspaceTargets) : [];
  for (const [workspace, value] of entries) {
    const key = normalizeWorkspace(workspace);
    const target = parseImportTarget(value);
    if (key && target) perWorkspace[key] = target;
  }
  return {
    agentApiBaseUrl: typeof agentApiBaseUrl === "string" && agentApiBaseUrl ? agentApiBaseUrl : DEFAULT_CONFIG.agentApiBaseUrl,
    importTarget: parseImportTarget(importTarget) ?? DEFAULT_CONFIG.importTarget,
    workspaceTargets: perWorkspace,
  };
}

export function saveConfig(config: MermaidLocalConfig, configPath = CONFIG_PATH): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
