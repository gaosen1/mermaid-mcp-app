#!/usr/bin/env node
/**
 * Edits mermaid-local-config.json (agent-api base URL + default projectName
 * used by the "导入 Mermaid Local" toolbar button). Zero dependencies, same
 * style as Mermaid Local's own scripts/agent-api.mjs.
 *
 * Usage:
 *   node configure.mjs get
 *   node configure.mjs set-url http://127.0.0.1:4789
 *   node configure.mjs set-project "我的项目"
 */
import fs from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.join(import.meta.dirname, "mermaid-local-config.json");

const DEFAULTS = {
  agentApiBaseUrl: "http://127.0.0.1:4789",
  defaultProjectName: "Claude 渲染图",
};

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

const [, , cmd, value] = process.argv;

if (cmd === "get" || !cmd) {
  console.log(JSON.stringify(load(), null, 2));
} else if (cmd === "set-url" && value) {
  const config = load();
  config.agentApiBaseUrl = value;
  save(config);
  console.log(`agentApiBaseUrl = ${value}`);
} else if (cmd === "set-project" && value) {
  const config = load();
  config.defaultProjectName = value;
  save(config);
  console.log(`defaultProjectName = ${value}`);
} else {
  console.log("usage: node configure.mjs get | set-url <url> | set-project <name>");
  process.exit(cmd ? 1 : 0);
}
