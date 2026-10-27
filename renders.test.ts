import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRenderStore } from "./renders";

let dir: string;
let store: ReturnType<typeof createRenderStore>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "renders-"));
  store = createRenderStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("save / load", () => {
  it("stores a mermaid render as .mmd beside a sidecar and reads it back", async () => {
    const saved = await store.save({ type: "mermaid", source: "flowchart LR\nA-->B", title: "登录流程", workspace: "/work/a" });
    expect(fs.existsSync(path.join(dir, `${saved.id}.mmd`))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${saved.id}.json`), "utf8"))).toMatchObject({ title: "登录流程", type: "mermaid" });
    expect(await store.load(saved.id)).toEqual(saved);
  });

  it("stores a markdown render as .md, not .mmd, and reads it back as markdown", async () => {
    const saved = await store.save({ type: "markdown", source: "# 标题\n\n```mermaid\nflowchart LR\nA-->B\n```", title: "说明文档", workspace: "/work/a" });
    expect(fs.existsSync(path.join(dir, `${saved.id}.md`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${saved.id}.mmd`))).toBe(false);
    expect(await store.load(saved.id)).toMatchObject({ type: "markdown", source: expect.stringContaining("# 标题"), title: "说明文档" });
  });

  it("remembers the workspace of the session that made it", async () => {
    const saved = await store.save({ type: "mermaid", source: "x", title: "t", workspace: "/work/a" });
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${saved.id}.json`), "utf8")).workspace).toBe("/work/a");
    expect((await store.load(saved.id))?.workspace).toBe("/work/a");
  });

  it("creates the directory on first save", async () => {
    const nested = createRenderStore(path.join(dir, "a", "b"));
    const saved = await nested.save({ type: "mermaid", source: "x", title: "t", workspace: "/w" });
    expect((await nested.load(saved.id))?.source).toBe("x");
  });

  it("gives each render its own id", async () => {
    const [a, b] = await Promise.all([1, 2].map(() => store.save({ type: "mermaid", source: "x", title: "t", workspace: "/w" })));
    expect(a.id).not.toBe(b.id);
  });
});

describe("renders written before types existed", () => {
  it("loads a sidecar without a type as mermaid", async () => {
    fs.writeFileSync(path.join(dir, "old.mmd"), "flowchart LR\nA-->B");
    fs.writeFileSync(path.join(dir, "old.json"), JSON.stringify({ title: "旧图", createdAt: "2026-10-07T09:00:00.000Z" }));
    expect(await store.load("old")).toEqual({ id: "old", type: "mermaid", source: "flowchart LR\nA-->B", title: "旧图", workspace: null, createdAt: "2026-10-07T09:00:00.000Z" });
  });

  it("loads a render with no sidecar at all, untitled", async () => {
    fs.writeFileSync(path.join(dir, "bare.mmd"), "flowchart LR\nA-->B");
    expect(await store.load("bare")).toMatchObject({ type: "mermaid", title: null, createdAt: "" });
  });
});

describe("load failures", () => {
  it("returns null for an unknown id", async () => {
    expect(await store.load("nope")).toBeNull();
  });

  it("returns null when only the sidecar survived", async () => {
    fs.writeFileSync(path.join(dir, "orphan.json"), JSON.stringify({ title: "t", type: "markdown" }));
    expect(await store.load("orphan")).toBeNull();
  });

  it("does not find a markdown render's source under the mermaid extension", async () => {
    fs.writeFileSync(path.join(dir, "wrong.mmd"), "x");
    fs.writeFileSync(path.join(dir, "wrong.json"), JSON.stringify({ type: "markdown" }));
    expect(await store.load("wrong")).toBeNull();
  });
});

describe("prune", () => {
  it("removes files older than 30 days and keeps recent ones", async () => {
    const recent = await store.save({ type: "markdown", source: "keep", title: "t", workspace: "/w" });
    fs.writeFileSync(path.join(dir, "stale.mmd"), "drop");
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, "stale.mmd"), sixtyDaysAgo, sixtyDaysAgo);
    await store.prune();
    expect(fs.existsSync(path.join(dir, "stale.mmd"))).toBe(false);
    expect(await store.load(recent.id)).not.toBeNull();
  });

  it("never throws when the directory is missing", async () => {
    await expect(createRenderStore(path.join(dir, "missing")).prune()).resolves.toBeUndefined();
  });
});
