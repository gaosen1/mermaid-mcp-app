import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import {
  McpServer,
  ResourceTemplate,
  type CallToolResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/server";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  loadConfig,
  normalizeWorkspace,
  resolveImportTarget,
  saveConfig,
  withImportTarget,
  workspaceLabel,
} from "./config.js";
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
  type AgentNote,
  type LibraryItem,
  type NoteUpdate,
  type OrganizeAction,
} from "./mermaid-local.js";
import { bakeInitialState } from "./bake.js";
import { renderLibrary } from "./library-outline.js";
import { NoteSourceError, readNoteSource, type NoteSource } from "./note-source.js";
import { createRenderStore } from "./renders.js";
import { CONTENT_TYPES } from "./src/content-type.js";
import { describeTarget, normalizeFolderPath, type ImportTarget, type TargetProject } from "./src/targets.js";

// Works both from source (server.ts, run via tsx) and compiled (dist/server.js).
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

// Same idea, but resolving back to the project root regardless of dev/prod,
// since the data dir below must survive rebuilds (unlike dist/, which vite
// repopulates) and must NOT live inside dist/.
const PROJECT_ROOT = import.meta.filename.endsWith(".ts")
  ? import.meta.dirname
  : path.join(import.meta.dirname, "..");

const MCP_APP_HTML_PATH = path.join(DIST_DIR, "mcp-app.html");

// MCP Apps hosts are allowed to cache a ui:// resource for the lifetime of a
// server connection (that's the point of "prefetching"). Since this server
// restarts far more often during development than the connection does,
// baking a content hash into the URI means every rebuild is a genuinely new
// resource — the host can never hand back a stale, pre-toolbar version.
const VIEW_VERSION = fsSync.existsSync(MCP_APP_HTML_PATH)
  ? crypto.createHash("sha256").update(fsSync.readFileSync(MCP_APP_HTML_PATH)).digest("hex").slice(0, 12)
  : "dev";

// Generic, call-independent shell: what every host falls back to if it
// doesn't honor the per-call resourceUri override below. Behaves exactly
// like before this change (data arrives only via ui/notifications/tool-*).
const RESOURCE_URI = `ui://mermaid/viewer-${VIEW_VERSION}.html`;

// Per-call resource: each render_mermaid call gets its own `ui://` address
// with the Mermaid source persisted to disk and baked directly into the
// returned HTML (see renderCallHtml below). This is deliberately redundant
// with the tool-input/tool-result notifications: it exists so the diagram
// can still render even if a host has stopped redelivering those
// notifications for an old call (observed after a session sits idle long
// enough that Claude Desktop recycles this server's process — see
// docs/persistence-experiment.md). Whether any given host actually re-reads
// this URI (rather than just the generic one above) when redisplaying an
// old message is NOT documented by the ext-apps spec; this is an
// experiment, verified by inspecting what the host actually requests.
const RENDER_RESOURCE_URI_TEMPLATE = "ui://mermaid/viewer/{id}.html";
const renders = createRenderStore(path.join(PROJECT_ROOT, "data", "renders"));

interface ToolOutcome {
  ok: boolean;
  message: string;
}

interface SaveOutcome extends ToolOutcome {
  /** Mermaid Local's id for the saved note; what delete_agent_note takes. */
  id?: string;
}

const failure = (err: unknown): ToolOutcome => ({
  ok: false,
  message:
    err instanceof MermaidLocalError || err instanceof NoteSourceError
      ? err.message
      : `Mermaid Local 请求失败：${err instanceof Error ? err.message : String(err)}`,
});

/**
 * Imports a persisted render into the user's Mermaid Local notes app. Errors
 * come back as a message for the viewer rather than being thrown: this runs
 * from a toolbar click with no retry/model loop around it.
 */
async function importRenderToMermaidLocal(id: string): Promise<ToolOutcome> {
  const config = loadConfig();

  const render = await renders.load(id);
  if (render === null) {
    return { ok: false, message: `找不到这次渲染的源码（id: ${id}），可能已经被清理。` };
  }
  const importTarget = resolveImportTarget(config, render.workspace);

  try {
    await importDiagram(config.agentApiBaseUrl, {
      name: render.title || id,
      type: render.type,
      source: render.source,
      target: importTarget,
    });
  } catch (err) {
    return failure(err);
  }
  return {
    ok: true,
    message: `已投递到 Mermaid Local 的「${describeTarget(importTarget)}」：Mermaid Local 页面开着时会立即导入，没开则在下次打开时导入。`,
  };
}

/**
 * Carries out an edit of an existing note and reports what really happened. The Mermaid Local page does the
 * work, so when one is open we wait for its answer: otherwise a refused edit (the note changed since it was
 * read) would be reported to the model as a success.
 */
async function applyNoteUpdate(ref: string, update: NoteUpdate, label: string): Promise<ToolOutcome> {
  const { agentApiBaseUrl } = loadConfig();
  const queued = await updateNote(agentApiBaseUrl, ref, update);
  if (queued.commandId === undefined) {
    return { ok: true, message: `「${label}」还在 Mermaid Local 的待导入队列里，已直接改写待导入的内容。` };
  }
  if (!queued.pageOpen) {
    return {
      ok: true,
      message: `已请求修改「${label}」：Mermaid Local 页面没开，下次打开时执行；执行前会先把旧版本存进该笔记的「历史」。`,
    };
  }
  const outcome = await waitForCommand(agentApiBaseUrl, queued.commandId);
  if (outcome === null) {
    return { ok: true, message: `已请求修改「${label}」，但还没等到 Mermaid Local 页面确认；稍后在页面里看结果，或再读一次这条笔记核对。` };
  }
  return { ok: outcome.status === "applied", message: `「${label}」：${outcome.message}` };
}

/**
 * Imports an HTML page straight into Mermaid Local, at the import target of
 * the workspace it came from. No render and no button: the model only calls
 * this when the user has already said "keep this one". With `replaces`, the
 * page goes into that existing note instead (same id and URL, old version kept in its history).
 */
async function saveHtmlNote(
  title: string,
  workspace: string,
  source: NoteSource,
  replaces: string | undefined,
): Promise<SaveOutcome> {
  const config = loadConfig();
  try {
    const html = await readNoteSource(source, { textParam: "html", htmlFile: true });
    if (replaces !== undefined) {
      const note = await resolveNote(config.agentApiBaseUrl, replaces);
      if (note.type !== "html") {
        return { ok: false, message: `「${note.name}」是 ${note.type} 笔记，不能用 HTML 页面替换它（笔记类型改不了）。` };
      }
      return { ...(await applyNoteUpdate(note.id, { source: html, name: title }, note.name)), id: note.id };
    }
    const target = resolveImportTarget(config, normalizeWorkspace(workspace));
    const { id } = await importDiagram(config.agentApiBaseUrl, { name: title, type: "html", source: html, target });
    return {
      ok: true,
      id,
      message: `已把「${title}」投递到 Mermaid Local 的「${describeTarget(target)}」：Mermaid Local 页面开着时会立即导入，没开则在下次打开时导入。笔记 id：${id}（之后要替换或撤回这一版，把它交给 save_html_note 的 replaces，或 delete_agent_note）。`,
    };
  } catch (err) {
    return failure(err);
  }
}

interface ReadNoteOutcome extends ToolOutcome {
  id?: string;
  name?: string;
  type?: string;
  baseHash?: string;
  source?: string;
}

/** Hands the model a note's current source, plus the fingerprint an edit has to be based on. */
async function readNoteForModel(ref: string, saveTo: string | undefined): Promise<ReadNoteOutcome> {
  try {
    const { note, source } = await readNote(loadConfig().agentApiBaseUrl, ref);
    const meta = { id: note.id, name: note.name, type: note.type, baseHash: note.hash ?? undefined };
    const header = `「${note.name}」（${note.type}，${note.projectName ?? "默认项目"}${note.folderPath ? ` / ${note.folderPath}` : ""}）\nid: ${note.id}\nbaseHash: ${note.hash}（改它时把这个值传给 update_note 的 baseHash，笔记之后被改过就不会被覆盖）`;
    if (saveTo !== undefined) {
      if (!path.isAbsolute(saveTo)) return { ok: false, message: `saveTo 必须是绝对路径：${saveTo}` };
      await fs.writeFile(saveTo, source, "utf-8");
      return { ok: true, ...meta, message: `${header}\n内容（${Buffer.byteLength(source, "utf-8")} 字节）已写入 ${saveTo}` };
    }
    return { ok: true, ...meta, source, message: `${header}\n\n${source}` };
  } catch (err) {
    return failure(err);
  }
}

/** Replaces a note's content (and optionally its title) in place. */
async function updateNoteForModel(
  ref: string,
  source: NoteSource,
  title: string | undefined,
  baseHash: string | undefined,
): Promise<ToolOutcome> {
  try {
    const note = await resolveNote(loadConfig().agentApiBaseUrl, ref);
    const content = await readNoteSource(source, { textParam: "content", htmlFile: note.type === "html" });
    return await applyNoteUpdate(note.id, { source: content, name: title, baseHash }, note.name);
  } catch (err) {
    return failure(err);
  }
}

interface LibraryOutcome extends ToolOutcome {
  projects?: { name: string; items: LibraryItem[] }[];
}

async function readLibraryForModel(project: string | undefined): Promise<LibraryOutcome> {
  try {
    const all = await readLibrary(loadConfig().agentApiBaseUrl);
    const projects = project === undefined ? all : all.filter((p) => p.name === project);
    if (project !== undefined && projects.length === 0) {
      return { ok: false, message: `找不到项目「${project}」。现有项目：${all.map((p) => p.name).join("、") || "（没有）"}` };
    }
    return { ok: true, projects, message: renderLibrary(projects) };
  } catch (err) {
    return failure(err);
  }
}

/** Submits a batch of reorganization steps and reports what the page did with them. */
async function organizeForModel(project: string, actions: OrganizeAction[]): Promise<ToolOutcome> {
  try {
    const { agentApiBaseUrl } = loadConfig();
    const queued = await organizeProject(agentApiBaseUrl, project, actions);
    if (!queued.pageOpen) {
      return { ok: true, message: `已提交整理「${project}」的 ${actions.length} 个动作：Mermaid Local 页面没开，下次打开时执行；执行时如果有一步不合法，整批都不会改。` };
    }
    const outcome = await waitForCommand(agentApiBaseUrl, queued.commandId!);
    if (outcome === null) {
      return { ok: true, message: `已提交整理「${project}」，但还没等到 Mermaid Local 页面确认；稍后用 get_library_tree 看现在的结构。` };
    }
    return { ok: outcome.status === "applied", message: outcome.message };
  } catch (err) {
    return failure(err);
  }
}

/** Lists the notes this server saved into Mermaid Local, so one of them can be picked for deletion. */
async function listSavedNotes(query: string | undefined, type: string | undefined): Promise<ToolOutcome & { notes: AgentNote[] }> {
  try {
    const notes = await listAgentNotes(loadConfig().agentApiBaseUrl, { query, type });
    if (notes.length === 0) return { ok: true, notes, message: "没有符合条件的、由 Agent 保存的笔记。" };
    const lines = notes.map(
      (n) => `- ${n.id}  [${n.type}] ${n.name}  （${n.projectName ?? "默认项目"}${n.folderPath ? ` / ${n.folderPath}` : ""}，${n.status === "pending" ? "等待导入" : "已导入"}，${new Date(n.createdAt).toLocaleString("zh-CN", { hour12: false })}）`,
    );
    return { ok: true, notes, message: `由 Agent 保存的笔记（新的在前）：\n${lines.join("\n")}` };
  } catch (err) {
    return { ...failure(err), notes: [] };
  }
}

/** Deletes one note this server saved earlier; Mermaid Local refuses ids it did not come from. */
async function deleteSavedNote(id: string): Promise<ToolOutcome> {
  try {
    const outcome = await deleteAgentNote(loadConfig().agentApiBaseUrl, id);
    return {
      ok: true,
      message:
        outcome === "cancelled"
          ? `笔记 ${id} 还在 Mermaid Local 的待导入队列里，已撤销，不会出现在笔记库。`
          : `已请求删除笔记 ${id}：Mermaid Local 页面开着时会立即删除，没开则在下次打开时删除。`,
    };
  } catch (err) {
    return failure(err);
  }
}

interface ImportTargetsOutcome extends ToolOutcome {
  current: ImportTarget;
  /** Name of the workspace `current` belongs to; "" = the fallback shared by workspaces without their own. */
  scope: string;
  projects: TargetProject[];
}

const scopeOf = (workspace: string | null) => (workspace ? workspaceLabel(workspace) : "");

/**
 * What the viewer's picker shows for one render: the import target in force for
 * the workspace that made it, plus everything Mermaid Local currently has.
 */
async function readImportTargets(id: string): Promise<ImportTargetsOutcome> {
  const config = loadConfig();
  const render = await renders.load(id);
  const current = resolveImportTarget(config, render?.workspace ?? null);
  const scope = scopeOf(render?.workspace ?? null);
  try {
    return { ok: true, message: "", current, scope, projects: await listTargets(config.agentApiBaseUrl) };
  } catch (err) {
    return { ...failure(err), current, scope, projects: [] };
  }
}

/** Saves the target for the workspace that made render `id` — other workspaces are untouched. */
async function writeImportTarget(
  id: string,
  project: string,
  folderPath: string,
): Promise<ToolOutcome & { current: ImportTarget }> {
  const render = await renders.load(id);
  if (render === null) {
    return {
      ok: false,
      message: `找不到这次渲染（id: ${id}），无法确定它属于哪个工作目录。`,
      current: resolveImportTarget(loadConfig(), null),
    };
  }
  const current: ImportTarget = { project: project.trim(), folderPath: normalizeFolderPath(folderPath) };
  saveConfig(withImportTarget(loadConfig(), render.workspace, current));
  const scope = scopeOf(render.workspace);
  return {
    ok: true,
    message: `${scope ? `「${scope}」的` : ""}默认导入位置已设为「${describeTarget(current)}」`,
    current,
  };
}

const RENDER_MERMAID_DESCRIPTION = `Render a Mermaid diagram — or a Markdown document with Mermaid diagrams embedded in it — inline in the conversation as an interactive, visual result (not a code block).

When to call this tool:
- The explanation involves a flowchart, sequence diagram, architecture/component diagram, state diagram, ER diagram, class diagram, Gantt chart, or any other relationship/process that Mermaid can express and a picture would make clearer than prose.
- Prefer calling this tool over simply printing a \`\`\`mermaid code fence, whenever the host supports rendering it — the user sees an actual rendered diagram, not source text.
- Use \`type: "markdown"\` when the diagram can't stand on its own: a bare diagram is often too abstract to keep as a note, and a few sentences of context beside it make it useful later. Write a short document — headings, lists, tables, prose — with the diagram(s) in \`\`\`mermaid fences, and it is rendered with the diagrams drawn in place.

Input contract:
- \`type\` (optional, default "mermaid"): "mermaid" or "markdown". It decides what \`code\` is, and what the user gets when they import the result into their notes (Mermaid Local).
- type "mermaid": pass ONLY the raw Mermaid diagram source as \`code\` (e.g. starting with "flowchart", "sequenceDiagram", "classDiagram", "erDiagram", "stateDiagram-v2", "gantt", etc.). Do not wrap it in a markdown code fence and do not include any other prose in \`code\`.
- type "markdown": pass the whole Markdown document as \`code\`. Put each diagram in its own \`\`\`mermaid fence; do not wrap the document itself in a fence. Keep the prose tight and in the language the user is writing in.
- Always also pass \`workspace\` (required): the absolute path of your session's primary working directory (the project the user is working in), exactly as your environment reports it. The viewer remembers where the user wants diagrams imported separately for each workspace, so pass the same path for every call in a session; do not make one up or use a subfolder.
- Always also pass \`title\` (required): a short (under ~60 chars) human-readable label for what this is about (e.g. "会议 Runtime 冷启动时序" or "登录鉴权流程"). It is shown in the top bar of the rendered result, and it becomes the name of the note when the user imports it into their notes (Mermaid Local) and labels it in the local gallery, so make it specific and meaningful rather than generic.

Layout (every Mermaid diagram, including those inside a markdown document): the viewer always uses the dagre layout, which follows natural reading order. Do not set \`layout: elk\` or other layout engines in frontmatter/directives — they are ignored.\n\nStyling (use this — don't just default to plain rectangles):
- Match node SHAPE to its semantic role wherever the diagram type supports it. In flowcharts: \`([text])\` stadium for start/end, \`{text}\` diamond for a decision/branch, \`[(text)]\` cylinder for a database/store, \`[[text]]\` subroutine for a predefined/external process, \`[/text/]\` parallelogram for input/output, \`{{text}}\` hexagon for a preparation/config step, plain \`[text]\` rectangle for an ordinary step.
- Highlight the 1–3 nodes that actually matter for the point being made (e.g. the failure branch, the final state, the bottleneck) with distinct color via \`classDef\` + \`class\`, for example:
  \`classDef danger fill:#4a1f24,stroke:#e5484d,color:#fff\`
  \`classDef success fill:#1f3a2a,stroke:#3ecf6e,color:#fff\`
  \`classDef highlight fill:#3a2f1f,stroke:#e5a53a,color:#fff\`
  ... then \`class NodeId1,NodeId2 danger\`. Keep the rest of the nodes on Mermaid's default styling — over-coloring every node defeats the point of highlighting.
- These are just a starting palette; pick colors/classes that fit what's actually being emphasized (error vs. success vs. "pay attention here") rather than applying them mechanically.

Dependency isolation (important):
- This tool renders the diagram entirely inside its own MCP App UI. All rendering dependencies (Mermaid, etc.) are bundled and managed by this MCP server itself.
- Never install mermaid, echarts, chart.js, or any other charting/rendering package into the user's current project to satisfy a visualization need — that is never necessary and must be avoided.
- Never modify the user's project package.json (or lockfile) in order to draw a diagram. If a diagram is needed, call this tool instead.`;

const SAVE_HTML_DESCRIPTION = `Save an HTML page the user has ALREADY seen — typically an interactive visualization published earlier in this conversation as an artifact/web page — into the user's local notes app (Mermaid Local) as an HTML note.

When to call this tool:
- ONLY when the user explicitly asks to save / keep / import / persist an existing HTML page into Mermaid Local (e.g. "把这个可视化存到 Mermaid Local").
- Never call it to create, show or preview a visualization. Keep making HTML visualizations the way you normally do (the host's own artifacts / web pages); this tool renders nothing — it only files a page the user decided is worth keeping.
- Do not use it for Mermaid diagrams or Markdown notes; render_mermaid covers those and imports them from its own viewer.

Input contract:
- Pass exactly one of \`path\` and \`html\`:
  - \`path\` (preferred whenever the page exists as a local file, e.g. the file you published an artifact from): absolute path to the .html file. It is read as-is, so the saved note is the exact page, and you don't have to re-send it.
  - \`html\`: the page's complete, self-contained HTML document, exactly as published (same scripts, styles and data) — use this only when there is no local file and no way to get one, e.g. a page made in a chat. Do not trim, summarize or "improve" it.
- If the user points at a published artifact link (e.g. a claude.ai artifact URL) or at a page from an earlier conversation, and you have no local copy: first read it with whatever tool you have for published artifacts so that it is saved to a local .html file, then pass that file as \`path\`. Do not paste the page into \`html\` when a file can be had — re-typing a whole page costs far more than reading it once.
- \`title\` (required): short, specific name for the note (e.g. "两数之和 · 哈希表查找过程"). It becomes the note's name in Mermaid Local.
- \`workspace\` (required): the absolute path of your session's primary working directory, exactly as your environment reports it — the same value you pass to render_mermaid. It picks where in Mermaid Local the note lands.

The result says where the note was filed, or why it couldn't be, and gives the note's id; relay the location to the user and keep the id.

Saving the same page twice makes two notes. When you are saving a corrected version of a page that is already in Mermaid Local (one you saved earlier — use the id from that result — or one the user points you at by its URL), pass \`replaces\`: the page goes into that note in place, so its id, URL, folder and tags stay, and the old version is kept in the note's history. \`replaces\` needs an HTML note, and \`title\` becomes its new name. Do not save a new copy and then delete the old one.`;

const READ_NOTE_DESCRIPTION = `Read a note from the user's Mermaid Local — any note, not only ones you saved — by its id or by its URL (the address bar of the Mermaid Local page, e.g. http://localhost:5173/project/4fdbf199/diagram/c2cdb76b). Returns the note's source and a \`baseHash\`.

Use it before editing a note with update_note: you cannot edit what you have not read. Pass the \`baseHash\` back to update_note so the edit is refused if the user changed the note in the meantime.

Large notes (HTML pages are often tens of KB): pass \`saveTo\` (an absolute path) to write the source to a file instead of returning it, then read or edit that file with your normal file tools — this keeps the page out of your context until you need parts of it. The content is as of Mermaid Local's last sync (a couple of seconds behind the page).`;

const UPDATE_NOTE_DESCRIPTION = `Replace the content of an existing Mermaid Local note in place — any note the user has, identified by its id or its URL (see read_note). The note keeps its id, URL, folder and tags. Mermaid Local saves the previous version to the note's history first, so the user can roll back with one click.

When to call this: the user asks you to change, fix or update a specific note ("fix the merge sort code in this note" + its URL), or you are correcting a note you saved earlier. Read it first with read_note and pass its \`baseHash\`: if the user edited the note after you read it, nothing is overwritten and you are told so — read it again and redo the edit. Without \`baseHash\` the content is overwritten unconditionally.

Send the note's COMPLETE new content, not a patch. Pass it as \`path\` (an absolute path to a local file — preferred, costs no tokens) or \`content\` (inline). For an HTML note use a .html file or inline HTML. The note's type cannot change, and image notes cannot be edited. \`title\` renames it.

The edit is carried out by the open Mermaid Local page; the result says whether it was applied, refused (the note changed since you read it) or is waiting for the page to be opened.`;

const GET_LIBRARY_TREE_DESCRIPTION = `Show how the user's Mermaid Local notes are organized: every project (or just one) as an outline of folders and notes, in the order the app displays them (folders and notes are mixed at each level). Folders are shown with their full path ("算法/排序/"), notes with their type, title and id (first 8 characters).

Use it before organize_notes — you need the current structure, the folder paths and the note ids. It is as of Mermaid Local's last sync (a couple of seconds behind the page).`;

const ORGANIZE_NOTES_DESCRIPTION = `Reorganize the notes of ONE Mermaid Local project: create, rename and move folders, move notes into folders, and change the order of items. This is the user's own library, so it is only for when they ask for it ("把这些笔记按主题分组", "把排序相关的放到一个文件夹", "按时间重排").

Call get_library_tree first. Then send all the steps as one batch in \`actions\`, run in order (a later step sees the effect of earlier ones, e.g. create a folder and then move notes into it). The batch is checked as a whole: if any step is invalid NOTHING is changed and you are told which step and why — fix it and send the batch again.

Steps (folder paths are inside the project, "a/b"; an empty path "" is the project root):
- {op:"create_folder", path} — creates the missing folders of the path; fine if it exists.
- {op:"rename_folder", path, name} — name is a single folder name, no "/".
- {op:"move_folder", path, to} — to = new parent path ("" = root); created if missing. Appended at the end.
- {op:"move_notes", notes:[id...], to} — note ids (or 6+ character id prefixes) from get_library_tree; to = target folder ("" = root), created if missing. Appended at the end in the order given.
- {op:"reorder", in, order:[{note:id}|{folder:name}...]} — within one folder; the listed items come first in that order, the rest follow in their current order.

Not possible on purpose: deleting folders or notes, moving notes to another project, editing a note's content (use update_note). For a big restructuring, tell the user your plan (what goes where) before you run it, unless they already told you exactly what to do. Folders are matched by name, so two sibling folders with the same name cannot be addressed — the step is refused.

The change is carried out by the open Mermaid Local page, and the tool waits for its answer.`;

const LIST_AGENT_NOTES_DESCRIPTION = `List the notes that were saved into the user's Mermaid Local through this server (save_html_note, or the viewer's "→ Mermaid Local" button), newest first, with their ids. Notes the user wrote themselves are never listed.

Call it only to find the id of a note you need to delete — for example you saved a page in an earlier turn or conversation and no longer have its id. Use \`query\` (title substring) to narrow it down.`;

const DELETE_AGENT_NOTE_DESCRIPTION = `Delete one note that was saved into Mermaid Local through this server, by the id save_html_note (or list_agent_notes) gave you.

When to call this:
- The user asks you to remove a note you saved.
- You saved a page by mistake (wrong page, test) and it should not exist at all.
To fix or update a note, do NOT delete it and save a new one: use save_html_note with \`replaces\` or update_note, which keep the note's id and URL. Never delete a note just to tidy up, and never delete one the user did not ask about. This cannot be undone from here (the user can restore it only if cloud sync still has it).

It only works on notes saved through this server; Mermaid Local refuses the user's own notes. The delete is carried out by the Mermaid Local page: immediately if it is open, otherwise the next time it is opened. If the note was still waiting to be imported, it is cancelled and never appears.`;

/**
 * Creates a new MCP server instance with the render_mermaid tool and its UI resource registered.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "Mermaid MCP App",
    version: "1.0.0",
  });

  // Two-part registration: tool + resource, tied together by the resource URI.
  registerAppTool(
    server,
    "render_mermaid",
    {
      title: "Render Mermaid Diagram",
      description: RENDER_MERMAID_DESCRIPTION,
      inputSchema: z.object({
        code: z
          .string()
          .min(1, "code must be non-empty")
          .describe(
            "What to render. For type 'mermaid' (the default): the raw Mermaid source, e.g. 'flowchart LR\\nA-->B'. For type 'markdown': a Markdown document whose ```mermaid fences are drawn inline.",
          ),
        // Optional with a default (unlike title) on purpose: the safe reading of
        // a call without it is the original behaviour — a Mermaid diagram — and
        // a session still holding an older tool schema must keep working.
        type: z
          .enum(CONTENT_TYPES)
          .optional()
          .describe("'mermaid' (default): `code` is a diagram. 'markdown': `code` is a document with ```mermaid fences."),
        // Required, not guessed server-side: the host runs one server process
        // for every session and its `roots` are the union of all of their
        // workspaces, so only the model knows which session this call is in.
        workspace: z
          .string()
          .trim()
          .min(1, "workspace must be the session's working directory")
          .describe("Absolute path of this session's primary working directory, e.g. '/Users/me/projects/app'"),
        // Required: the title becomes the item name when a render is imported
        // into Mermaid Local, so leaving it to the model's discretion produced
        // id-named notes whenever a call skipped it.
        title: z
          .string()
          .min(1, "title must be a short non-empty label")
          .describe("Short human-readable label for what this is about, e.g. '会议 Runtime 冷启动时序'"),
      }),
      outputSchema: z.object({
        code: z.string(),
        id: z.string(),
        title: z.string(),
        type: z.enum(CONTENT_TYPES),
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI } }, // Links this tool to its UI resource
    },
    async ({ code, title, workspace, type = "mermaid" }): Promise<CallToolResult> => {
      // Validation of the Mermaid syntax itself happens client-side in the
      // View (mermaid.parse), since Mermaid's parser only runs in a DOM
      // environment. The tool's job is just to hand the source to the UI;
      // a short text fallback keeps non-MCP-Apps hosts informed.
      const { id } = await renders.save({ type, source: code, title, workspace: normalizeWorkspace(workspace) });
      void renders.prune();

      const callResourceUri = RENDER_RESOURCE_URI_TEMPLATE.replace("{id}", id);
      const lines = code.split("\n").length;
      const fallback =
        type === "markdown"
          ? `Rendered a Markdown document (${lines} lines). Source:\n\n${code}`
          : `Rendered a Mermaid diagram (${lines} lines). Source:\n\`\`\`mermaid\n${code}\n\`\`\``;

      return {
        content: [{ type: "text", text: fallback }],
        structuredContent: { code, id, title, type },
        // Both forms set since it's undocumented which one (if either) a
        // given host honors on a *result* rather than a *tool*.
        _meta: {
          ui: { resourceUri: callResourceUri },
          "ui/resourceUri": callResourceUri,
        },
      };
    },
  );

  // Model-visible but deliberately NOT a render_mermaid type and not an app
  // tool: HTML visualizations stay on the host's own artifact path, and this
  // only files one into Mermaid Local once the user asks to keep it.
  server.registerTool(
    "save_html_note",
    {
      title: "Save HTML page to Mermaid Local",
      description: SAVE_HTML_DESCRIPTION,
      inputSchema: z.object({
        title: z.string().trim().min(1, "title must be a short non-empty label").describe("Name of the note, e.g. '两数之和 · 哈希表查找过程'"),
        workspace: z
          .string()
          .trim()
          .min(1, "workspace must be the session's working directory")
          .describe("Absolute path of this session's primary working directory, e.g. '/Users/me/projects/app'"),
        path: z.string().optional().describe("Absolute path of a local .html file holding the page. Pass this or `html`, not both."),
        html: z.string().optional().describe("The page's complete HTML document, verbatim. Pass this or `path`, not both."),
        replaces: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Id or Mermaid Local URL of an existing HTML note to replace in place instead of creating a new note"),
      }),
      outputSchema: z.object({ ok: z.boolean(), message: z.string(), id: z.string().optional() }),
    },
    async ({ title, workspace, path: file, html, replaces }): Promise<CallToolResult> => {
      const result = await saveHtmlNote(title, workspace, { path: file, text: html }, replaces);
      return { content: [{ type: "text", text: result.message }], structuredContent: { ...result }, isError: !result.ok };
    },
  );

  server.registerTool(
    "read_note",
    {
      title: "Read a note from Mermaid Local",
      description: READ_NOTE_DESCRIPTION,
      inputSchema: z.object({
        note: z.string().trim().min(1, "note must be a note id or its Mermaid Local URL").describe("The note's id, or its URL in Mermaid Local"),
        saveTo: z.string().optional().describe("Absolute path to write the source to instead of returning it"),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
        message: z.string(),
        id: z.string().optional(),
        name: z.string().optional(),
        type: z.string().optional(),
        baseHash: z.string().optional(),
        source: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ note, saveTo }): Promise<CallToolResult> => {
      const result = await readNoteForModel(note, saveTo);
      return { content: [{ type: "text", text: result.message }], structuredContent: { ...result }, isError: !result.ok };
    },
  );

  server.registerTool(
    "update_note",
    {
      title: "Update a note in Mermaid Local",
      description: UPDATE_NOTE_DESCRIPTION,
      inputSchema: z.object({
        note: z.string().trim().min(1, "note must be a note id or its Mermaid Local URL").describe("The note's id, or its URL in Mermaid Local"),
        baseHash: z.string().optional().describe("The baseHash read_note returned for the version you edited; the edit is refused if the note changed since"),
        title: z.string().trim().min(1).optional().describe("New name for the note; omit to keep it"),
        path: z.string().optional().describe("Absolute path of a local file holding the note's complete new content. Pass this or `content`, not both."),
        content: z.string().optional().describe("The note's complete new content, inline. Pass this or `path`, not both."),
      }),
      outputSchema: z.object({ ok: z.boolean(), message: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ note, baseHash, title, path: file, content }): Promise<CallToolResult> => {
      const result = await updateNoteForModel(note, { path: file, text: content }, title, baseHash);
      return { content: [{ type: "text", text: result.message }], structuredContent: { ...result }, isError: !result.ok };
    },
  );

  server.registerTool(
    "get_library_tree",
    {
      title: "Show how Mermaid Local notes are organized",
      description: GET_LIBRARY_TREE_DESCRIPTION,
      inputSchema: z.object({
        project: z.string().trim().min(1).optional().describe("Only this project (by name); omit for every project"),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
        message: z.string(),
        projects: z.array(z.object({ name: z.string(), items: z.array(z.any()) })).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ project }): Promise<CallToolResult> => {
      const result = await readLibraryForModel(project);
      return { content: [{ type: "text", text: result.message }], structuredContent: { ...result }, isError: !result.ok };
    },
  );

  const organizeActionSchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("create_folder"), path: z.string() }),
    z.object({ op: z.literal("rename_folder"), path: z.string(), name: z.string() }),
    z.object({ op: z.literal("move_folder"), path: z.string(), to: z.string() }),
    z.object({ op: z.literal("move_notes"), notes: z.array(z.string()).min(1), to: z.string() }),
    z.object({
      op: z.literal("reorder"),
      in: z.string(),
      order: z.array(z.union([z.object({ note: z.string() }).strict(), z.object({ folder: z.string() }).strict()])).min(1),
    }),
  ]);

  server.registerTool(
    "organize_notes",
    {
      title: "Reorganize a Mermaid Local project",
      description: ORGANIZE_NOTES_DESCRIPTION,
      inputSchema: z.object({
        project: z.string().trim().min(1, "project must be the project's name").describe("Name of the project to reorganize"),
        actions: z.array(organizeActionSchema).min(1).describe("The steps, run in order as one all-or-nothing batch"),
      }),
      outputSchema: z.object({ ok: z.boolean(), message: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ project, actions }): Promise<CallToolResult> => {
      const result = await organizeForModel(project, actions);
      return { content: [{ type: "text", text: result.message }], structuredContent: { ...result }, isError: !result.ok };
    },
  );

  server.registerTool(
    "list_agent_notes",
    {
      title: "List notes saved to Mermaid Local",
      description: LIST_AGENT_NOTES_DESCRIPTION,
      inputSchema: z.object({
        query: z.string().trim().optional().describe("Only notes whose title contains this text (case-insensitive)"),
        type: z.enum(["mermaid", "markdown", "html", "txt"]).optional().describe("Only notes of this type"),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
        message: z.string(),
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
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, type }): Promise<CallToolResult> => {
      const result = await listSavedNotes(query || undefined, type);
      return { content: [{ type: "text", text: result.message }], structuredContent: { ...result }, isError: !result.ok };
    },
  );

  server.registerTool(
    "delete_agent_note",
    {
      title: "Delete a note saved to Mermaid Local",
      description: DELETE_AGENT_NOTE_DESCRIPTION,
      inputSchema: z.object({
        id: z.string().trim().min(1, "id must be the note id from save_html_note or list_agent_notes").describe("The note's id"),
      }),
      outputSchema: z.object({ ok: z.boolean(), message: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ id }): Promise<CallToolResult> => {
      const result = await deleteSavedNote(id);
      return { content: [{ type: "text", text: result.message }], structuredContent: { ...result }, isError: !result.ok };
    },
  );

  // App-only tools (visibility: ["app"]): wired to the viewer's "→ Mermaid
  // Local" button and its target picker, never callable by the model.
  // Importing is deliberately a separate, explicit tool rather than a
  // render_mermaid side-effect: it is a human "this one's worth keeping"
  // decision, not something that should happen on every render.
  const appOnly = { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } };
  const renderIdSchema = z.string().min(1).describe("The render id of the diagram (same id as in its resourceUri)");

  registerAppTool(
    server,
    "import_to_mermaid_local",
    {
      title: "Import to Mermaid Local",
      description:
        "App-only: copies a previously rendered diagram into the user's Mermaid Local notes app, at their chosen default project/folder. Never call this yourself — it's wired to a toolbar button in the viewer.",
      inputSchema: z.object({
        id: renderIdSchema,
      }),
      outputSchema: z.object({ ok: z.boolean(), message: z.string() }),
      _meta: appOnly,
    },
    async ({ id }): Promise<CallToolResult> => {
      const result = await importRenderToMermaidLocal(id);
      return { content: [{ type: "text", text: result.message }], structuredContent: result };
    },
  );

  const targetSchema = z.object({ project: z.string(), folderPath: z.string() });

  registerAppTool(
    server,
    "list_import_targets",
    {
      title: "List Mermaid Local import targets",
      description:
        "App-only: the projects and folders in the user's Mermaid Local plus the saved default import target of the workspace that made render `id`. Never call this yourself — it feeds the viewer's target picker.",
      inputSchema: z.object({ id: renderIdSchema }),
      outputSchema: z.object({
        ok: z.boolean(),
        message: z.string(),
        current: targetSchema,
        scope: z.string(),
        projects: z.array(z.object({ name: z.string(), folders: z.array(z.string()) })),
      }),
      _meta: appOnly,
    },
    async ({ id }): Promise<CallToolResult> => {
      const result = await readImportTargets(id);
      return { content: [{ type: "text", text: result.message || "ok" }], structuredContent: { ...result } };
    },
  );

  registerAppTool(
    server,
    "set_import_target",
    {
      title: "Set Mermaid Local import target",
      description:
        "App-only: saves the default project/folder that \"→ Mermaid Local\" imports into, for the workspace that made render `id` only. Never call this yourself — it's wired to the viewer's target picker.",
      inputSchema: z.object({
        id: renderIdSchema,
        project: z.string().trim().min(1).describe("Mermaid Local project name (created on import if it doesn't exist)"),
        folderPath: z.string().describe("Folder path inside the project, e.g. \"多模态/对比学习\"; empty string = project root"),
      }),
      outputSchema: z.object({ ok: z.boolean(), message: z.string(), current: targetSchema }),
      _meta: appOnly,
    },
    async ({ id, project, folderPath }): Promise<CallToolResult> => {
      const result = await writeImportTarget(id, project, folderPath);
      return { content: [{ type: "text", text: result.message }], structuredContent: { ...result } };
    },
  );

  // Generic shell resource: the tool-level default. Used verbatim by any
  // host that ignores the per-call resourceUri override above.
  registerAppResource(
    server,
    "Mermaid Viewer",
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(MCP_APP_HTML_PATH, "utf-8");

      return {
        contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  // Per-call resource: same HTML shell, but with that specific call's
  // Mermaid source baked in directly, read back from disk rather than from
  // any in-memory/notification-based state. This is what lets a diagram
  // keep rendering even after this server process has been restarted.
  server.registerResource(
    "Mermaid Viewer (per-call)",
    new ResourceTemplate(RENDER_RESOURCE_URI_TEMPLATE, { list: undefined }),
    { mimeType: RESOURCE_MIME_TYPE },
    async (uri, variables): Promise<ReadResourceResult> => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      const render = id ? await renders.load(id) : null;

      const shell = await fs.readFile(MCP_APP_HTML_PATH, "utf-8");
      const html = render ? bakeInitialState(shell, render) : shell;

      return {
        contents: [{ uri: uri.toString(), mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
