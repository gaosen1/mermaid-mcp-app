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

/** Drops a note into Mermaid Local's inbox; the open page (or the next page load) imports it. */
export async function importDiagram(base: string, { name, type, source, target }: DiagramImport): Promise<void> {
  const res = await request(base, "/api/diagrams", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader(base)) },
    body: JSON.stringify({ name, type, source, projectName: target.project, folderPath: target.folderPath }),
  });
  if (!res.ok) throw new MermaidLocalError(await failureMessage(res, "导入失败"));
}
