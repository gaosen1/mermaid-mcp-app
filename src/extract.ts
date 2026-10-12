import type { CallToolResult } from "@modelcontextprotocol/client";

export interface RenderPayload {
  code: string;
  id: string | null;
}

function fromRecord(value: unknown): RenderPayload | null {
  if (!value || typeof value !== "object") return null;
  const { code, id } = value as { code?: unknown; id?: unknown };
  if (typeof code !== "string" || code.length === 0) return null;
  return { code, id: typeof id === "string" ? id : null };
}

/**
 * Reads the diagram source (and render id) out of a tool result.
 *
 * Live results carry `structuredContent`. A host replaying a saved
 * conversation does not: Claude's Code tab drops `structuredContent` and
 * `_meta`, and hands back only `content`, where the same payload appears as
 * JSON text (it echoes structuredContent into the text block). So the source
 * is recovered from that text; a plain ```mermaid fence is the last resort
 * for hosts that deliver only the server's own human-readable text.
 */
export function extractPayload(result: CallToolResult): RenderPayload | null {
  const live = fromRecord(result.structuredContent);
  if (live) return live;

  const texts = (result.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : []));

  for (const text of texts) {
    try {
      const parsed = fromRecord(JSON.parse(text));
      if (parsed) return parsed;
    } catch {
      // not JSON — try the next block
    }
  }

  for (const text of texts) {
    const fenced = text.match(/```mermaid\n([\s\S]*?)\n```/)?.[1];
    if (fenced) return { code: fenced, id: null };
  }
  return null;
}
