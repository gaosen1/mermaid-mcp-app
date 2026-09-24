import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import {
  McpServer,
  type CallToolResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/server";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { z } from "zod";

// Works both from source (server.ts, run via tsx) and compiled (dist/server.js).
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

const MCP_APP_HTML_PATH = path.join(DIST_DIR, "mcp-app.html");

// MCP Apps hosts are allowed to cache a ui:// resource for the lifetime of a
// server connection (that's the point of "prefetching"). Since this server
// restarts far more often during development than the connection does,
// baking a content hash into the URI means every rebuild is a genuinely new
// resource — the host can never hand back a stale, pre-toolbar version.
const VIEW_VERSION = fsSync.existsSync(MCP_APP_HTML_PATH)
  ? crypto.createHash("sha256").update(fsSync.readFileSync(MCP_APP_HTML_PATH)).digest("hex").slice(0, 12)
  : "dev";

const RESOURCE_URI = `ui://mermaid/viewer-${VIEW_VERSION}.html`;

const RENDER_MERMAID_DESCRIPTION = `Render a Mermaid diagram inline in the conversation as an interactive, visual chart (not a code block).

When to call this tool:
- The explanation involves a flowchart, sequence diagram, architecture/component diagram, state diagram, ER diagram, class diagram, Gantt chart, or any other relationship/process that Mermaid can express and a picture would make clearer than prose.
- Prefer calling this tool over simply printing a \`\`\`mermaid code fence, whenever the host supports rendering it — the user sees an actual rendered diagram, not source text.

Input contract:
- Pass ONLY the raw Mermaid diagram source as \`code\` (e.g. starting with "flowchart", "sequenceDiagram", "classDiagram", "erDiagram", "stateDiagram-v2", "gantt", etc.). Do not wrap it in a markdown code fence and do not include any other prose in \`code\`.

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
      }),
      outputSchema: z.object({
        code: z.string(),
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI } }, // Links this tool to its UI resource
    },
    async ({ code }): Promise<CallToolResult> => {
      // Validation of the Mermaid syntax itself happens client-side in the
      // View (mermaid.parse), since Mermaid's parser only runs in a DOM
      // environment. The tool's job is just to hand the source to the UI;
      // a short text fallback keeps non-MCP-Apps hosts informed.
      const preview = code.length > 200 ? `${code.slice(0, 200)}…` : code;
      return {
        content: [
          {
            type: "text",
            text: `Rendered a Mermaid diagram (${code.split("\n").length} lines). Source:\n\`\`\`mermaid\n${preview}\n\`\`\``,
          },
        ],
        structuredContent: { code },
      };
    },
  );

  // Register the resource, which returns the bundled HTML/JS/CSS for the UI
  // (Mermaid included) as a single self-contained document.
  registerAppResource(
    server,
    "Mermaid Viewer",
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");

      return {
        contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
