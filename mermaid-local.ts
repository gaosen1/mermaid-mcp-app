import { z } from "zod";
import type { ContentType } from "./src/content-type.js";
import type { ImportTarget, TargetProject } from "./src/targets.js";

/** A failure talking to Mermaid Local's agent-api, phrased for the person who clicked the button. */
export class MermaidLocalError extends Error {}

const SETUP_HINT = "请确认 Mermaid Local 正在运行（pnpm dev / pnpm preview 会自动启动这个同步服务），并且已在它的 Web 应用里选过「本地 Agent 同步」目录。";

const manifestSchema = z.object({
  projects: z.array(z.object({ name: z.string(), folders: z.array(z.string()) })),
});

const syncedAtSchema = z.object({ syncedAt: z.number() });

const formatTime = (ms: number) => new Date(ms).toLocaleString("zh-CN", { hour12: false });

const trimSlash = (base: string) => base.replace(/\/+$/, "");

async function request(base: string, route: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${trimSlash(base)}${route}`, init);
  } catch (err) {
    throw new MermaidLocalError(
      `连不上 Mermaid Local 的本地同步服务（${trimSlash(base)}）。${SETUP_HINT}原始错误：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function failureMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : `${fallback}：HTTP ${res.status}`;
}

async function authHeader(base: string): Promise<Record<string, string>> {
  const res = await request(base, "/api/auth/token");
  if (!res.ok) throw new MermaidLocalError(await failureMessage(res, "获取同步服务的 token 失败"));
  const body = (await res.json().catch(() => ({}))) as { token?: unknown };
  if (typeof body.token !== "string") throw new MermaidLocalError("同步服务的响应里没有 token 字段。");
  return { Authorization: `Bearer ${body.token}` };
}

/** Every project and folder path currently in Mermaid Local, from the manifest its last sync wrote. */
export async function listTargets(base: string): Promise<TargetProject[]> {
  const res = await request(base, "/api/manifest", { headers: await authHeader(base) });
  if (res.status === 404) {
    throw new MermaidLocalError(`Mermaid Local 还没有同步过。${SETUP_HINT}`);
  }
  if (!res.ok) throw new MermaidLocalError(await failureMessage(res, "读取项目列表失败"));
  const body = await res.json().catch(() => null);
  const parsed = manifestSchema.safeParse(body);
  if (!parsed.success) {
    // Mermaid Local rewrites manifest.json (with the project list) on every sync. If it has no list the page has
    // not synced since it learned to write one — in practice almost always because the browser dropped the
    // sync folder's access and is waiting for a click on "允许访问", not because anything is out of date.
    const last = syncedAtSchema.safeParse(body);
    const lastSync = last.success ? `上次同步：${formatTime(last.data.syncedAt)}` : "没有同步记录";
    throw new MermaidLocalError(
      `Mermaid Local 还没有写出项目列表（${lastSync}）。请打开 Mermaid Local →「设置」→「本地 Agent 同步」，如果提示「浏览器需要重新授权目录访问权限」，点「允许访问」，它会自动完成同步。`,
    );
  }
  return parsed.data.projects;
}

/**
 * Item types this server sends to Mermaid Local, named as Mermaid Local names them. Wider than what
 * render_mermaid draws: an HTML page is only ever imported (save_html_note), never rendered.
 */
export type NoteType = ContentType | "html";

export interface DiagramImport {
  name: string;
  /** Becomes the item's type in Mermaid Local. */
  type: NoteType;
  source: string;
  target: ImportTarget;
}

/**
 * Drops a note into Mermaid Local's inbox; the open page (or the next page load) imports it.
 * Returns the id the note will have there, which is what `deleteAgentNote` takes.
 */
export async function importDiagram(base: string, { name, type, source, target }: DiagramImport): Promise<{ id: string }> {
  const res = await request(base, "/api/diagrams", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader(base)) },
    body: JSON.stringify({ name, type, source, projectName: target.project, folderPath: target.folderPath }),
  });
  if (!res.ok) throw new MermaidLocalError(await failureMessage(res, "导入失败"));
  const body = (await res.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== "string") {
    // An agent-api older than the delete tool accepts the note but cannot say what to call it.
    throw new MermaidLocalError(`笔记已投递，但同步服务没有返回笔记 id（它可能还是旧版本）。${SETUP_HINT}重启它之后再试。`);
  }
  return { id: body.id };
}

export interface AgentNote {
  id: string;
  name: string;
  type: string;
  projectName: string | null;
  folderPath: string | null;
  createdAt: number;
  /** `pending`: still queued in Mermaid Local's inbox; `present`: imported. */
  status: "pending" | "present";
}

const agentNotesSchema = z.object({
  notes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      projectName: z.string().nullable(),
      folderPath: z.string().nullable(),
      createdAt: z.number(),
      status: z.enum(["pending", "present"]),
    }),
  ),
});

/** Notes that were written into Mermaid Local through this server (and so may be deleted through it), newest first. */
export async function listAgentNotes(base: string, filter: { query?: string; type?: string } = {}): Promise<AgentNote[]> {
  const params = new URLSearchParams();
  if (filter.query) params.set("q", filter.query);
  if (filter.type) params.set("type", filter.type);
  const qs = params.size > 0 ? `?${params}` : "";
  const res = await request(base, `/api/agent-notes${qs}`, { headers: await authHeader(base) });
  if (!res.ok) throw new MermaidLocalError(await failureMessage(res, "读取已保存的笔记失败"));
  const parsed = agentNotesSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new MermaidLocalError(`同步服务返回的笔记列表格式不对（它可能是旧版本）。${SETUP_HINT}`);
  return parsed.data.notes;
}

/**
 * Deletes a note this server wrote earlier. `cancelled`: it was still queued and never reached Mermaid Local;
 * `queued`: the delete is waiting for the open page (or the next page load) to carry it out.
 */
export async function deleteAgentNote(base: string, id: string): Promise<"cancelled" | "queued"> {
  const res = await request(base, `/api/diagrams/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: await authHeader(base),
  });
  if (!res.ok) throw new MermaidLocalError(await failureMessage(res, "删除失败"));
  return res.status === 200 ? "cancelled" : "queued";
}

/** A note as agent-api describes it. `hash` is the fingerprint of its source: what an edit must be based on. */
export interface NoteRef {
  id: string;
  name: string;
  type: string;
  projectName: string | null;
  folderPath: string | null;
  hash: string | null;
  /** `pending`: still queued in Mermaid Local's inbox and not readable yet. */
  status: "pending" | "present";
}

const noteRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  projectName: z.string().nullable(),
  folderPath: z.string().nullable(),
  hash: z.string().nullable(),
  status: z.enum(["pending", "present"]),
});

/** Finds one note from its id (or a prefix of it) or from its URL in Mermaid Local; refuses to guess between several. */
export async function resolveNote(base: string, ref: string): Promise<NoteRef> {
  const res = await request(base, `/api/notes/resolve?ref=${encodeURIComponent(ref)}`, { headers: await authHeader(base) });
  if (!res.ok) throw new MermaidLocalError(await failureMessage(res, "找不到这条笔记"));
  const parsed = noteRefSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new MermaidLocalError(`同步服务返回的笔记信息格式不对（它可能是旧版本）。${SETUP_HINT}`);
  return parsed.data;
}

/** The note's current source as of Mermaid Local's last sync, with the fingerprint to pass back when editing it. */
export async function readNote(base: string, ref: string): Promise<{ note: NoteRef; source: string }> {
  const note = await resolveNote(base, ref);
  if (note.status === "pending") {
    throw new MermaidLocalError(`「${note.name}」还在等 Mermaid Local 导入，现在读不到；打开 Mermaid Local 页面后再试。`);
  }
  const res = await request(base, `/api/diagrams/${encodeURIComponent(note.id)}/assets/source`, { headers: await authHeader(base) });
  if (!res.ok) throw new MermaidLocalError(await failureMessage(res, `读取「${note.name}」的内容失败`));
  return { note, source: await res.text() };
}

export interface NoteUpdate {
  source: string;
  name?: string;
  /** The `hash` of the version the new content was written from; the edit is refused if the note has changed since. */
  baseHash?: string;
}

export interface QueuedUpdate {
  id: string;
  /** Set when the page has to carry the edit out; absent when the note was still queued and was simply rewritten. */
  commandId?: string;
  /** Whether a Mermaid Local page is connected and will act on it right away. */
  pageOpen: boolean;
}

/** Asks Mermaid Local to replace a note's content in place. The page does the work; see `waitForCommand`. */
export async function updateNote(base: string, ref: string, update: NoteUpdate): Promise<QueuedUpdate> {
  const res = await request(base, `/api/diagrams/${encodeURIComponent(ref)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await authHeader(base)) },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new MermaidLocalError(await failureMessage(res, "修改失败"));
  const body = (await res.json().catch(() => ({}))) as { id?: unknown; commandId?: unknown; notified?: unknown };
  if (typeof body.id !== "string") throw new MermaidLocalError(`同步服务的响应里没有笔记 id（它可能是旧版本）。${SETUP_HINT}`);
  return {
    id: body.id,
    commandId: typeof body.commandId === "string" ? body.commandId : undefined,
    pageOpen: typeof body.notified === "number" && body.notified > 0,
  };
}

export interface CommandOutcome {
  status: "applied" | "conflict" | "missing" | "unsupported";
  message: string;
}

const commandOutcomeSchema = z.object({
  status: z.enum(["pending", "applied", "conflict", "missing", "unsupported"]),
  message: z.string().optional(),
});

/** Polls until the page has answered an update command; `null` if it has not within the time given. */
export async function waitForCommand(
  base: string,
  commandId: string,
  { timeoutMs = 8000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<CommandOutcome | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(base, `/api/commands/${encodeURIComponent(commandId)}`, { headers: await authHeader(base) });
    if (res.ok) {
      const parsed = commandOutcomeSchema.safeParse(await res.json().catch(() => null));
      if (parsed.success && parsed.data.status !== "pending") {
        return { status: parsed.data.status, message: parsed.data.message ?? "" };
      }
    }
    if (Date.now() + intervalMs >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
