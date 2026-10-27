#!/usr/bin/env node
/**
 * Edits mermaid-local-config.json from the shell (the viewer's "▾" picker
 * writes the same file). Uses the compiled config module so the defaults and
 * validation live in one place — run `pnpm run build` first.
 *
 * Usage:
 *   node configure.mjs get
 *   node configure.mjs set-url http://127.0.0.1:4789
 *   node configure.mjs set-target <project> [folderPath] [--workspace <dir>]
 *       no folderPath = project root; no --workspace = the default for workspaces without their own
 */
import { loadConfig, normalizeWorkspace, saveConfig, withImportTarget } from "./dist/config.js";
import { describeTarget, normalizeFolderPath } from "./dist/src/targets.js";

const [, , cmd, ...rest] = process.argv;
const flagAt = rest.indexOf("--workspace");
const workspace = flagAt === -1 ? null : normalizeWorkspace(rest[flagAt + 1] ?? "") || null;
const args = flagAt === -1 ? rest : rest.slice(0, flagAt);
const config = loadConfig();

if (cmd === "get" || !cmd) {
  console.log(JSON.stringify(config, null, 2));
} else if (cmd === "set-url" && args[0]) {
  saveConfig({ ...config, agentApiBaseUrl: args[0] });
  console.log(`agentApiBaseUrl = ${args[0]}`);
} else if (cmd === "set-target" && args[0]?.trim() && (flagAt === -1 || workspace)) {
  const target = { project: args[0].trim(), folderPath: normalizeFolderPath(args[1] ?? "") };
  saveConfig(withImportTarget(config, workspace, target));
  console.log(`${workspace ?? "default"} -> ${describeTarget(target)}`);
} else {
  console.log("usage: node configure.mjs get | set-url <url> | set-target <project> [folderPath] [--workspace <dir>]");
  process.exit(cmd ? 1 : 0);
}
