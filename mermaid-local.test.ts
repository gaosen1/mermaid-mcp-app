import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteAgentNote,
  importDiagram,
  listAgentNotes,
  listTargets,
  MermaidLocalError,
  organizeProject,
  readLibrary,
  readNote,
  resolveNote,
  updateNote,
  waitForCommand,
} from "./mermaid-local";

let server: http.Server;
let base: string;
let manifest: unknown;
let manifestStatus: number;
let posts: Array<{ auth: string | undefined; body: unknown }>;
let postStatus: number;
let postBody: unknown;
let agentNotes: unknown;
let deleteResult: { status: number; body: unknown };
let deletes: string[];
let noteQueries: string[];
let resolveResult: { status: number; body: unknown };
let noteSource: { status: number; text: string };
let updateResult: { status: number; body: unknown };
let updates: Array<{ path: string; body: unknown }>;
let commandStatuses: unknown[];
let resolveRefs: string[];
let organizeResult: { status: number; body: unknown };
let organizeRequests: unknown[];

beforeEach(async () => {
  manifest = { projects: [{ name: "LLM", folders: ["多模态", "多模态/对比学习"] }] };
  manifestStatus = 200;
  posts = [];
  postStatus = 202;
  postBody = { ok: true, id: "note-1" };
  agentNotes = { count: 0, notes: [] };
  deleteResult = { status: 202, body: { ok: true } };
  deletes = [];
  noteQueries = [];
  resolveResult = {
    status: 200,
    body: { id: "note-1", name: "排序算法", type: "html", projectName: "LLM", folderPath: null, hash: "h1", status: "present" },
  };
  noteSource = { status: 200, text: "<p>source</p>" };
  updateResult = { status: 202, body: { ok: true, id: "note-1", commandId: "cmd-1", notified: 1 } };
  updates = [];
  commandStatuses = [{ status: "pending" }, { status: "applied", message: "已更新" }];
  resolveRefs = [];
  organizeResult = { status: 202, body: { ok: true, commandId: "cmd-org", notified: 1 } };
  organizeRequests = [];
  server = http.createServer((req, res) => {
    const send = (code: number, payload: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.url === "/api/auth/token") return send(200, { token: "tok" });
    if (req.headers.authorization !== "Bearer tok") return send(401, { error: "token 无效" });
    if (req.url === "/api/manifest") return send(manifestStatus, manifestStatus === 200 ? manifest : { error: "manifest.json 不存在" });
    if (req.url === "/api/diagrams" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        posts.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        send(postStatus, postStatus === 202 ? postBody : { error: "folderPath 必须是字符串" });
      });
      return;
    }
    if (req.url === "/api/organize" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        organizeRequests.push(JSON.parse(raw));
        send(organizeResult.status, organizeResult.body);
      });
      return;
    }
    if (req.url?.startsWith("/api/notes/resolve")) {
      resolveRefs.push(new URL(req.url, "http://x").searchParams.get("ref") ?? "");
      return send(resolveResult.status, resolveResult.body);
    }
    if (req.url?.endsWith("/assets/source")) {
      res.writeHead(noteSource.status, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(noteSource.status === 200 ? noteSource.text : JSON.stringify({ error: "没有 source 产物" }));
    }
    if (req.url?.startsWith("/api/commands/")) {
      return send(200, commandStatuses.length > 1 ? commandStatuses.shift() : commandStatuses[0]);
    }
    if (req.method === "PUT" && req.url?.startsWith("/api/diagrams/")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        updates.push({ path: decodeURIComponent(req.url!.slice("/api/diagrams/".length)), body: JSON.parse(raw) });
        send(updateResult.status, updateResult.body);
      });
      return;
    }
    if (req.url?.startsWith("/api/agent-notes")) {
      noteQueries.push(new URL(req.url, "http://x").search);
      return send(200, agentNotes);
    }
    if (req.method === "DELETE" && req.url?.startsWith("/api/diagrams/")) {
      deletes.push(decodeURIComponent(req.url.slice("/api/diagrams/".length)));
      return send(deleteResult.status, deleteResult.body);
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("listTargets", () => {
  it("returns the project/folder tree from the manifest", async () => {
    expect(await listTargets(base)).toEqual([{ name: "LLM", folders: ["多模态", "多模态/对比学习"] }]);
  });

  it("tolerates a trailing slash on the base url", async () => {
    expect(await listTargets(`${base}/`)).toHaveLength(1);
  });

  it("explains that nothing has been synced yet", async () => {
    manifestStatus = 404;
    await expect(listTargets(base)).rejects.toThrow(/还没有同步过/);
  });

  it("points at the folder-access re-grant, with the last sync time, when the manifest has no project list", async () => {
    manifest = { app: "mermaid-local", count: 3, syncedAt: Date.UTC(2026, 9, 8, 12, 0, 0) };
    const error = await listTargets(base).catch((e) => e);
    expect(error).toBeInstanceOf(MermaidLocalError);
    expect(error.message).toMatch(/还没有写出项目列表（上次同步：2026/);
    expect(error.message).toMatch(/允许访问/);
    expect(error.message).not.toMatch(/版本较旧|刷新/);
  });

  it("says there is no sync record when the manifest has neither a project list nor a timestamp", async () => {
    manifest = { app: "mermaid-local" };
    await expect(listTargets(base)).rejects.toThrow(/（没有同步记录）/);
  });

  it("reports an unreachable service as a MermaidLocalError that says how to start it", async () => {
    const error = await listTargets("http://127.0.0.1:1").catch((e) => e);
    expect(error).toBeInstanceOf(MermaidLocalError);
    expect(error.message).toMatch(/连不上 Mermaid Local/);
    expect(error.message).toMatch(/pnpm preview/);
  });
});

describe("importDiagram", () => {
  const diagram = { name: "登录流程", type: "mermaid" as const, source: "flowchart LR\nA-->B", target: { project: "LLM", folderPath: "多模态/对比学习" } };

  it("posts the diagram with its project and folder, authenticated", async () => {
    await importDiagram(base, diagram);
    expect(posts).toEqual([
      {
        auth: "Bearer tok",
        body: { name: "登录流程", type: "mermaid", source: "flowchart LR\nA-->B", projectName: "LLM", folderPath: "多模态/对比学习" },
      },
    ]);
  });

  it("posts a markdown document as type markdown", async () => {
    await importDiagram(base, { ...diagram, type: "markdown", source: "# 说明\n\n```mermaid\nflowchart LR\nA-->B\n```" });
    expect(posts[0].body).toMatchObject({ type: "markdown", source: expect.stringContaining("# 说明") });
  });

  it("posts an html page as type html", async () => {
    await importDiagram(base, { ...diagram, type: "html", source: "<!doctype html><title>t</title>" });
    expect(posts[0].body).toMatchObject({ type: "html", source: "<!doctype html><title>t</title>" });
  });

  it("sends an empty folderPath for the project root", async () => {
    await importDiagram(base, { ...diagram, target: { project: "LLM", folderPath: "" } });
    expect((posts[0].body as { folderPath: string }).folderPath).toBe("");
  });

  it("surfaces the service's own rejection message", async () => {
    postStatus = 400;
    await expect(importDiagram(base, diagram)).rejects.toThrow("folderPath 必须是字符串");
  });

  it("returns the id Mermaid Local gave the note", async () => {
    expect(await importDiagram(base, diagram)).toEqual({ id: "note-1" });
  });

  it("says to restart the sync service when it accepts the note but returns no id", async () => {
    postBody = { ok: true };
    await expect(importDiagram(base, diagram)).rejects.toThrow(/没有返回笔记 id.*重启/);
  });
});

describe("listAgentNotes", () => {
  const note = { id: "n1", name: "排序", type: "html", projectName: "LLM", folderPath: "", createdAt: 1, status: "present" };

  it("returns the notes the agent saved", async () => {
    agentNotes = { count: 1, notes: [note] };
    expect(await listAgentNotes(base)).toEqual([note]);
    expect(noteQueries).toEqual([""]);
  });

  it("passes the title and type filters through", async () => {
    await listAgentNotes(base, { query: "排序 算法", type: "html" });
    expect(new URLSearchParams(noteQueries[0]).get("q")).toBe("排序 算法");
    expect(new URLSearchParams(noteQueries[0]).get("type")).toBe("html");
  });

  it("complains about a response it cannot read instead of returning garbage", async () => {
    agentNotes = { notes: [{ id: "n1" }] };
    await expect(listAgentNotes(base)).rejects.toBeInstanceOf(MermaidLocalError);
  });
});

describe("deleteAgentNote", () => {
  it("asks the service to delete the note by id, authenticated, and reports it as queued", async () => {
    expect(await deleteAgentNote(base, "a/b c")).toBe("queued");
    expect(deletes).toEqual(["a/b c"]);
  });

  it("reports a note that never left the inbox as cancelled", async () => {
    deleteResult = { status: 200, body: { ok: true } };
    expect(await deleteAgentNote(base, "n1")).toBe("cancelled");
  });

  it("surfaces the refusal for a note it did not write", async () => {
    deleteResult = { status: 403, body: { error: "只能删除经 Agent 写回的笔记" } };
    await expect(deleteAgentNote(base, "n1")).rejects.toThrow("只能删除经 Agent 写回的笔记");
  });
});

describe("resolveNote", () => {
  it("asks the service to resolve an id or a URL and returns the note", async () => {
    const note = await resolveNote(base, "http://localhost:5173/project/4fdbf199/diagram/c2cdb76b");
    expect(resolveRefs).toEqual(["http://localhost:5173/project/4fdbf199/diagram/c2cdb76b"]);
    expect(note).toMatchObject({ id: "note-1", name: "排序算法", hash: "h1", status: "present" });
  });

  it("surfaces an ambiguous or unknown reference as the service words it", async () => {
    resolveResult = { status: 409, body: { error: "986165f7 对应多条笔记" } };
    await expect(resolveNote(base, "986165f7")).rejects.toThrow("对应多条笔记");
  });

  it("complains about a note description it cannot read (older service)", async () => {
    resolveResult = { status: 200, body: { id: "note-1" } };
    await expect(resolveNote(base, "x")).rejects.toBeInstanceOf(MermaidLocalError);
  });
});

describe("readNote", () => {
  it("returns the source with the note's fingerprint", async () => {
    expect(await readNote(base, "note-1")).toEqual({ note: expect.objectContaining({ id: "note-1", hash: "h1" }), source: "<p>source</p>" });
  });

  it("explains that a note still waiting in the inbox cannot be read yet", async () => {
    resolveResult = { status: 200, body: { ...(resolveResult.body as object), status: "pending", hash: null } };
    await expect(readNote(base, "note-1")).rejects.toThrow(/还在等 Mermaid Local 导入/);
  });

  it("surfaces a missing source", async () => {
    noteSource = { status: 404, text: "" };
    await expect(readNote(base, "note-1")).rejects.toThrow("没有 source 产物");
  });
});

describe("updateNote", () => {
  it("puts the new content (with name and base hash) and reports that a page will act on it", async () => {
    const queued = await updateNote(base, "note-1", { source: "<p>new</p>", name: "新标题", baseHash: "h1" });
    expect(updates).toEqual([{ path: "note-1", body: { source: "<p>new</p>", name: "新标题", baseHash: "h1" } }]);
    expect(queued).toEqual({ id: "note-1", commandId: "cmd-1", pageOpen: true });
  });

  it("sends a URL as the reference untouched", async () => {
    await updateNote(base, "http://localhost:5173/project/a/diagram/b", { source: "x" });
    expect(updates[0].path).toBe("http://localhost:5173/project/a/diagram/b");
  });

  it("reports a note that was still queued (no command) and a page that is not open", async () => {
    updateResult = { status: 200, body: { ok: true, id: "note-1", status: "applied" } };
    expect(await updateNote(base, "note-1", { source: "x" })).toEqual({ id: "note-1", commandId: undefined, pageOpen: false });
    updateResult = { status: 202, body: { ok: true, id: "note-1", commandId: "cmd-2", notified: 0 } };
    expect((await updateNote(base, "note-1", { source: "x" })).pageOpen).toBe(false);
  });

  it("surfaces a refusal, and a response without an id (older service)", async () => {
    updateResult = { status: 400, body: { error: "png 图片笔记没有文本源码，改不了" } };
    await expect(updateNote(base, "note-1", { source: "x" })).rejects.toThrow("图片笔记");
    updateResult = { status: 202, body: { ok: true } };
    await expect(updateNote(base, "note-1", { source: "x" })).rejects.toThrow(/旧版本/);
  });
});

describe("waitForCommand", () => {
  it("polls until the page answers", async () => {
    expect(await waitForCommand(base, "cmd-1", { timeoutMs: 2000, intervalMs: 5 })).toEqual({ status: "applied", message: "已更新" });
  });

  it("passes a refusal through", async () => {
    commandStatuses = [{ status: "conflict", message: "笔记在你读取之后被改过" }];
    expect(await waitForCommand(base, "cmd-1", { timeoutMs: 2000, intervalMs: 5 })).toEqual({
      status: "conflict",
      message: "笔记在你读取之后被改过",
    });
  });

  it("gives up with null when the page never answers", async () => {
    commandStatuses = [{ status: "pending" }];
    expect(await waitForCommand(base, "cmd-1", { timeoutMs: 60, intervalMs: 10 })).toBeNull();
  });
});

describe("readLibrary", () => {
  const organization = [
    { name: "算法笔记", items: [{ kind: "note", id: "n1", name: "Alpha", type: "html" }, { kind: "folder", name: "算法", items: [] }] },
  ];

  it("returns every project's tree from the manifest", async () => {
    manifest = { projects: [], organization };
    expect(await readLibrary(base)).toEqual(organization);
  });

  it("asks for a sync when the manifest has no tree yet (older page)", async () => {
    manifest = { projects: [{ name: "LLM", folders: [] }] };
    await expect(readLibrary(base)).rejects.toThrow(/还没有写出目录结构/);
  });

  it("explains that nothing has been synced yet", async () => {
    manifestStatus = 404;
    await expect(readLibrary(base)).rejects.toThrow(/还没有同步过/);
  });
});

describe("organizeProject", () => {
  const actions = [
    { op: "create_folder" as const, path: "精选" },
    { op: "reorder" as const, in: "", order: [{ note: "n1" }, { folder: "精选" }] },
  ];

  it("posts the project and the actions as given, and says whether a page will act on it", async () => {
    expect(await organizeProject(base, "算法笔记", actions)).toEqual({ id: "算法笔记", commandId: "cmd-org", pageOpen: true });
    expect(organizeRequests).toEqual([{ project: "算法笔记", actions }]);
  });

  it("surfaces the service's refusal (unknown project, unknown action)", async () => {
    organizeResult = { status: 404, body: { error: "找不到项目「x」。现有项目：算法笔记" } };
    await expect(organizeProject(base, "x", actions)).rejects.toThrow("现有项目：算法笔记");
  });

  it("complains about a response without a command id (older service)", async () => {
    organizeResult = { status: 202, body: { ok: true } };
    await expect(organizeProject(base, "算法笔记", actions)).rejects.toThrow(/旧版本/);
  });
});
