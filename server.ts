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
import { deleteAgentNote, importDiagram, listAgentNotes, listTargets, MermaidLocalError, type AgentNote } from "./mermaid-local.js";
import { bakeInitialState } from "./bake.js";
import { HtmlNoteError, readHtmlNote, type HtmlNoteSource } from "./html-note.js";
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
    err instanceof MermaidLocalError || err instanceof HtmlNoteError
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
 * Imports an HTML page straight into Mermaid Local, at the import target of
 * the workspace it came from. No render and no button: the model only calls
 * this when the user has already said "keep this one".
 */
async function saveHtmlNote(
  title: string,
  workspace: string,
  source: HtmlNoteSource,
): Promise<SaveOutcome> {
  const config = loadConfig();
  const target = resolveImportTarget(config, normalizeWorkspace(workspace));
  let id: string;
  try {
    const html = await readHtmlNote(source);
    ({ id } = await importDiagram(config.agentApiBaseUrl, { name: title, type: "html", source: html, target }));
  } catch (err) {
    return failure(err);
  }
  return {
    ok: true,
    id,
    message: `已把「${title}」投递到 Mermaid Local 的「${describeTarget(target)}」：Mermaid Local 页面开着时会立即导入，没开则在下次打开时导入。笔记 id：${id}（之后要撤回或替换这一版，把它交给 delete_agent_note）。`,
  };
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

Saving the same page twice makes two notes. If you saved a page that turns out to be wrong and are about to save a corrected one, delete the wrong one with delete_agent_note (using the id from this result) instead of leaving both.`;

const LIST_AGENT_NOTES_DESCRIPTION = `List the notes that were saved into the user's Mermaid Local through this server (save_html_note, or the viewer's "→ Mermaid Local" button), newest first, with their ids. Notes the user wrote themselves are never listed.

Call it only to find the id of a note you need to delete — for example you saved a page in an earlier turn or conversation and no longer have its id. Use \`query\` (title substring) to narrow it down.`;

const DELETE_AGENT_NOTE_DESCRIPTION = `Delete one note that was saved into Mermaid Local through this server, by the id save_html_note (or list_agent_notes) gave you.

When to call this:
- You saved an HTML page that has an error and you are saving the corrected version: delete the wrong one so the user is not left with duplicates.
- The user asks you to remove a note you saved.
Never delete a note just to tidy up, and never delete one the user did not ask about or that you did not save in order to replace it. This cannot be undone from here (the user can restore it only if cloud sync still has it).

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
      }),
      outputSchema: z.object({ ok: z.boolean(), message: z.string(), id: z.string().optional() }),
    },
    async ({ title, workspace, path: file, html }): Promise<CallToolResult> => {
      const result = await saveHtmlNote(title, workspace, { path: file, html });
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
