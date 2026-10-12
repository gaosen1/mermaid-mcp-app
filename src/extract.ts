import type { CallToolResult } from "@modelcontextprotocol/client";

export interface RenderPayload {
  code: string;
  id: string | null;
  title: string | null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function fromRecord(value: unknown): RenderPayload | null {
  if (!value || typeof value !== "object") return null;
  const { code, id, title } = value as { code?: unknown; id?: unknown; title?: unknown };
  const source = nonEmptyString(code);
  if (!source) return null;
  return { code: source, id: nonEmptyString(id), title: nonEmptyString(title) };
}

/**
 * Reads the diagram source (plus render id and title) out of a tool result.
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
    if (fenced) return { code: fenced, id: null, title: null };
  }
  return null;
}
