import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  loadConfig,
  normalizeWorkspace,
  resolveImportTarget,
  saveConfig,
  withImportTarget,
  workspaceLabel,
} from "./config";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mermaid-config-"));
  file = path.join(dir, "mermaid-local-config.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("loadConfig", () => {
  it("returns the defaults when the file does not exist", () => {
    expect(loadConfig(file)).toEqual(DEFAULT_CONFIG);
  });

  it("returns the defaults for unparseable content", () => {
    fs.writeFileSync(file, "{ not json");
    expect(loadConfig(file)).toEqual(DEFAULT_CONFIG);
  });

  it("round-trips a saved config", () => {
    const config = {
      agentApiBaseUrl: "http://127.0.0.1:5000",
      importTarget: { project: "LLM", folderPath: "多模态与跨模态/对比学习" },
      workspaceTargets: { "/work/a": { project: "A", folderPath: "x/y" } },
    };
    saveConfig(config, file);
    expect(loadConfig(file)).toEqual(config);
  });

  it("normalises the folder path and trims the project name on load", () => {
    fs.writeFileSync(file, JSON.stringify({ importTarget: { project: "  LLM ", folderPath: " a / b/ " } }));
    expect(loadConfig(file).importTarget).toEqual({ project: "LLM", folderPath: "a/b" });
  });

  it("falls back per field: a blank project resets the whole target, a bad url resets only the url", () => {
    fs.writeFileSync(file, JSON.stringify({ agentApiBaseUrl: 42, importTarget: { project: "  ", folderPath: "x" } }));
    expect(loadConfig(file)).toEqual(DEFAULT_CONFIG);
  });

  it("treats a missing or non-string folderPath as the project root", () => {
    fs.writeFileSync(file, JSON.stringify({ importTarget: { project: "医联" } }));
    expect(loadConfig(file).importTarget).toEqual({ project: "医联", folderPath: "" });
    fs.writeFileSync(file, JSON.stringify({ importTarget: { project: "医联", folderPath: 5 } }));
    expect(loadConfig(file).importTarget.folderPath).toBe("");
  });
});

describe("workspace targets", () => {
  it("normalises keys and values on load and drops entries without a project", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        workspaceTargets: {
          "/work/a/": { project: " A ", folderPath: " x / y/ " },
          "/work/b": { project: "  " },
          "/work/c": "nope",
          "  ": { project: "Z" },
        },
      }),
    );
    expect(loadConfig(file).workspaceTargets).toEqual({ "/work/a": { project: "A", folderPath: "x/y" } });
  });

  it("ignores a workspaceTargets that is not an object", () => {
    fs.writeFileSync(file, JSON.stringify({ workspaceTargets: ["/work/a"] }));
    expect(loadConfig(file).workspaceTargets).toEqual({});
    fs.writeFileSync(file, JSON.stringify({ workspaceTargets: 5 }));
    expect(loadConfig(file).workspaceTargets).toEqual({});
  });
});

describe("normalizeWorkspace / workspaceLabel", () => {
  it("trims and drops trailing slashes but keeps the root", () => {
    expect(normalizeWorkspace("  /a/b// ")).toBe("/a/b");
    expect(normalizeWorkspace("/")).toBe("/");
    expect(normalizeWorkspace("   ")).toBe("");
  });

  it("labels a workspace by its last segment", () => {
    expect(workspaceLabel("/Users/me/schedule-agent")).toBe("schedule-agent");
    expect(workspaceLabel("/")).toBe("/");
  });
});

describe("resolveImportTarget / withImportTarget", () => {
  const A = { project: "A", folderPath: "" };
  const B = { project: "B", folderPath: "b" };

  it("uses the workspace's own target, else the shared default (also for renders with no workspace)", () => {
    const config = withImportTarget(DEFAULT_CONFIG, "/work/a", A);
    expect(resolveImportTarget(config, "/work/a")).toEqual(A);
    expect(resolveImportTarget(config, "/work/other")).toEqual(DEFAULT_CONFIG.importTarget);
    expect(resolveImportTarget(config, null)).toEqual(DEFAULT_CONFIG.importTarget);
  });

  it("changing one workspace leaves the others and the default alone", () => {
    let config = withImportTarget(DEFAULT_CONFIG, "/work/a", A);
    config = withImportTarget(config, "/work/b", B);
    config = withImportTarget(config, "/work/a", B);
    expect(resolveImportTarget(config, "/work/a")).toEqual(B);
    expect(resolveImportTarget(config, "/work/b")).toEqual(B);
    expect(config.importTarget).toEqual(DEFAULT_CONFIG.importTarget);
  });

  it("without a workspace it sets the shared default and does not touch workspace entries", () => {
    const config = withImportTarget(withImportTarget(DEFAULT_CONFIG, "/work/a", A), null, B);
    expect(config.importTarget).toEqual(B);
    expect(config.workspaceTargets).toEqual({ "/work/a": A });
  });

  it("does not mutate its input", () => {
    withImportTarget(DEFAULT_CONFIG, "/work/a", A);
    expect(DEFAULT_CONFIG.workspaceTargets).toEqual({});
  });
});
