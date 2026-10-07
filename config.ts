import fs from "node:fs";
import path from "node:path";

// Mirrors the project-root resolution in server.ts: stable across dev
// (tsx running config.ts directly) and prod (compiled dist/config.js).
const PROJECT_ROOT = import.meta.filename.endsWith(".ts")
  ? import.meta.dirname
  : path.join(import.meta.dirname, "..");

const CONFIG_PATH = path.join(PROJECT_ROOT, "mermaid-local-config.json");

export interface MermaidLocalConfig {
  /** Base URL of the Mermaid Local `agent-api.mjs` REST server. */
  agentApiBaseUrl: string;
  /** `projectName` tag used when importing a diagram (auto-created if it doesn't exist yet). */
  defaultProjectName: string;
}

const DEFAULTS: MermaidLocalConfig = {
  agentApiBaseUrl: "http://127.0.0.1:4789",
  defaultProjectName: "Claude 渲染图",
};

/** Reads mermaid-local-config.json, falling back to DEFAULTS for missing/invalid fields. */
export function loadConfig(): MermaidLocalConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return {
      agentApiBaseUrl: typeof raw.agentApiBaseUrl === "string" ? raw.agentApiBaseUrl : DEFAULTS.agentApiBaseUrl,
      defaultProjectName:
        typeof raw.defaultProjectName === "string" ? raw.defaultProjectName : DEFAULTS.defaultProjectName,
    };
  } catch {
    return DEFAULTS;
  }
}
