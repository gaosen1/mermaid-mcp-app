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
import { loadConfig } from "./config.js";

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
const RENDERS_DIR = path.join(PROJECT_ROOT, "data", "renders");
fsSync.mkdirSync(RENDERS_DIR, { recursive: true });

const MAX_RENDER_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Best-effort cleanup so data/renders/ doesn't grow forever. Never throws. */
async function pruneOldRenders(): Promise<void> {
  try {
    const entries = await fs.readdir(RENDERS_DIR);
    const now = Date.now();
    await Promise.all(
      entries.map(async (entry) => {
        const filePath = path.join(RENDERS_DIR, entry);
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat && now - stat.mtimeMs > MAX_RENDER_AGE_MS) {
          await fs.unlink(filePath).catch(() => {});
        }
      }),
    );
  } catch {
    // Directory listing failed; not worth failing the tool call over.
  }
}

function renderIdToPath(id: string): string {
  return path.join(RENDERS_DIR, `${id}.mmd`);
}

interface RenderMeta {
  title?: string;
  createdAt: string;
}

function renderMetaPath(id: string): string {
  return path.join(RENDERS_DIR, `${id}.json`);
}

/**
 * Imports a persisted render into the user's Mermaid Local notes app via its
 * local `agent-api.mjs` REST server (see that script's own header comment
 * for the full protocol). Returns a user-facing message either way; errors
 * are reported back to the View rather than thrown, since this runs from a
 * toolbar click with no retry/model loop around it.
 */
async function importRenderToMermaidLocal(id: string): Promise<{ ok: boolean; message: string }> {
  const config = loadConfig();
  const base = config.agentApiBaseUrl.replace(/\/+$/, "");

  const code = await fs.readFile(renderIdToPath(id), "utf-8").catch(() => null);
  if (code === null) {
    return { ok: false, message: `找不到这次渲染的源码（id: ${id}），可能已经被清理。` };
  }
  const meta = await fs
    .readFile(renderMetaPath(id), "utf-8")
    .then((raw) => JSON.parse(raw) as RenderMeta)
    .catch(() => null);
  const name = meta?.title || id;

  let token: string;
  try {
    const tokenRes = await fetch(`${base}/api/auth/token`);
    if (!tokenRes.ok) throw new Error(`HTTP ${tokenRes.status}`);
    const tokenBody = (await tokenRes.json()) as { token?: string };
    if (typeof tokenBody.token !== "string") throw new Error("响应里没有 token 字段");
    token = tokenBody.token;
  } catch (err) {
    return {
      ok: false,
      message: `连不上 Mermaid Local 的本地同步服务（${base}）。请确认 Mermaid Local 正在运行（pnpm dev / pnpm preview 会自动启动这个同步服务），并且已在它的 Web 应用里选过「本地 Agent 同步」目录。原始错误：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const res = await fetch(`${base}/api/diagrams`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, type: "mermaid", source: code, projectName: config.defaultProjectName }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, message: body.error ?? `导入失败：HTTP ${res.status}` };
    }
    return { ok: true, message: `已投递到 Mermaid Local 的「${config.defaultProjectName}」项目：Mermaid Local 页面开着时几秒内自动导入，没开则在下次打开时导入。` };
  } catch (err) {
    return { ok: false, message: `导入请求失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Injects the persisted Mermaid source (and its id, so the View can later
 * call back with `import_to_mermaid_local`) into the generic HTML shell, so
 * the View can render immediately on load without waiting on (or depending
 * on) tool-input/tool-result notifications from the host. */
function bakeCodeIntoHtml(html: string, code: string, id: string): string {
  const script = `<script>window.__MERMAID_INITIAL_CODE__=${JSON.stringify(code)};window.__MERMAID_INITIAL_ID__=${JSON.stringify(id)};</script>`;
  return html.includes("</head>") ? html.replace("</head>", `${script}</head>`) : script + html;
}

const RENDER_MERMAID_DESCRIPTION = `Render a Mermaid diagram inline in the conversation as an interactive, visual chart (not a code block).

When to call this tool:
- The explanation involves a flowchart, sequence diagram, architecture/component diagram, state diagram, ER diagram, class diagram, Gantt chart, or any other relationship/process that Mermaid can express and a picture would make clearer than prose.
- Prefer calling this tool over simply printing a \`\`\`mermaid code fence, whenever the host supports rendering it — the user sees an actual rendered diagram, not source text.

Input contract:
- Pass ONLY the raw Mermaid diagram source as \`code\` (e.g. starting with "flowchart", "sequenceDiagram", "classDiagram", "erDiagram", "stateDiagram-v2", "gantt", etc.). Do not wrap it in a markdown code fence and do not include any other prose in \`code\`.
- Always also pass \`title\` (optional in the schema, but always provide it): a short (under ~60 chars) human-readable label for what this diagram is about (e.g. "会议 Runtime 冷启动时序" or "登录鉴权流程"). This is never shown to the user inline — it exists purely so a later archive/export of past diagrams is browsable instead of a wall of anonymous IDs.

Layout: the viewer always uses the dagre layout, which follows natural reading order. Do not set \`layout: elk\` or other layout engines in frontmatter/directives — they are ignored.\n\nStyling (use this — don't just default to plain rectangles):
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
          .min(1, "code must be non-empty Mermaid diagram source")
          .describe("Raw Mermaid diagram source, e.g. 'flowchart LR\\nA-->B'"),
        // Optional on purpose: a session whose cached tool schema predates
        // this field would otherwise have every call rejected outright.
        // Missing titles fall back to the file name in the gallery/import.
        title: z
          .string()
          .optional()
          .describe("Short human-readable label for what this diagram is about, e.g. '会议 Runtime 冷启动时序'"),
      }),
      outputSchema: z.object({
        code: z.string(),
        id: z.string(),
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI } }, // Links this tool to its UI resource
    },
    async ({ code, title }): Promise<CallToolResult> => {
      // Validation of the Mermaid syntax itself happens client-side in the
      // View (mermaid.parse), since Mermaid's parser only runs in a DOM
      // environment. The tool's job is just to hand the source to the UI;
      // a short text fallback keeps non-MCP-Apps hosts informed.
      const preview = code.length > 200 ? `${code.slice(0, 200)}…` : code;

      const id = crypto.randomUUID();
      const meta: RenderMeta = { title, createdAt: new Date().toISOString() };
      await Promise.all([
        fs.writeFile(renderIdToPath(id), code, "utf-8"),
        fs.writeFile(renderMetaPath(id), JSON.stringify(meta, null, 2), "utf-8"),
      ]);
      void pruneOldRenders();

      const callResourceUri = RENDER_RESOURCE_URI_TEMPLATE.replace("{id}", id);

      return {
        content: [
          {
            type: "text",
            text: `Rendered a Mermaid diagram (${code.split("\n").length} lines). Source:\n\`\`\`mermaid\n${preview}\n\`\`\``,
          },
        ],
        structuredContent: { code, id },
        // Both forms set since it's undocumented which one (if either) a
        // given host honors on a *result* rather than a *tool*.
        _meta: {
          ui: { resourceUri: callResourceUri },
          "ui/resourceUri": callResourceUri,
        },
      };
    },
  );

  // App-only tool (visibility: ["app"]): wired to the View's "导入 Mermaid
  // Local" toolbar button, never callable by the model. Deliberately a
  // separate tool rather than a render_mermaid side-effect — importing is a
  // human "this one's worth keeping" decision, not something that should
  // happen automatically on every render.
  registerAppTool(
    server,
    "import_to_mermaid_local",
    {
      title: "Import to Mermaid Local",
      description:
        "App-only: copies a previously rendered diagram into the user's Mermaid Local notes app via its local agent-sync API. Never call this yourself — it's wired to a toolbar button in the viewer.",
      inputSchema: z.object({
        id: z.string().min(1).describe("The render id of the diagram to import (same id as in its resourceUri)"),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
        message: z.string(),
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
    },
    async ({ id }): Promise<CallToolResult> => {
      const result = await importRenderToMermaidLocal(id);
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
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
      const code = id ? await fs.readFile(renderIdToPath(id), "utf-8").catch(() => null) : null;

      const shell = await fs.readFile(MCP_APP_HTML_PATH, "utf-8");
      const html = code !== null && id ? bakeCodeIntoHtml(shell, code, id) : shell;

      return {
        contents: [{ uri: uri.toString(), mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
