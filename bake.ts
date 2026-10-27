import type { ContentType } from "./src/content-type.js";

/**
 * Where the per-call page's initial state goes. An explicit marker rather than
 * "the first </head>": the viewer is one 5 MB file with every library inlined,
 * and a bundled library can contain that string inside its own code (DOMPurify
 * does), which once put the state in the middle of a JS string.
 */
export const BAKE_MARKER = "<!--mermaid-initial-state-->";

export interface BakedRender {
  id: string;
  type: ContentType;
  source: string;
  title: string | null;
}

/** JSON that is safe inside a <script> element: a "</script>" in the source must not end the block. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * Puts a render's source into the viewer's HTML so the page can draw it on load,
 * without waiting for (or depending on) the host to deliver the tool result.
 * Throws if the marker isn't there exactly once — a rebuilt viewer that lost it
 * should fail loudly, not serve a page that silently shows nothing.
 */
export function bakeInitialState(html: string, render: BakedRender): string {
  const parts = html.split(BAKE_MARKER);
  if (parts.length !== 2) {
    throw new Error(`Viewer HTML must contain ${BAKE_MARKER} exactly once, found ${parts.length - 1}.`);
  }
  const script =
    `<script>window.__MERMAID_INITIAL_CODE__=${scriptJson(render.source)};` +
    `window.__MERMAID_INITIAL_ID__=${scriptJson(render.id)};` +
    `window.__MERMAID_INITIAL_TITLE__=${scriptJson(render.title)};` +
    `window.__MERMAID_INITIAL_TYPE__=${scriptJson(render.type)};</script>`;
  // Concatenate rather than String.replace: "$&" or "$'" in a source would be read as replacement patterns.
  return parts[0] + script + parts[1];
}
