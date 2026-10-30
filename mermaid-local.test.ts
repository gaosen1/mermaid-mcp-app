import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAgentNote, importDiagram, listAgentNotes, listTargets, MermaidLocalError } from "./mermaid-local";

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
