import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { extractPayload } from "./extract";

const CODE = "flowchart LR\nA[开始] --> B[结束]";
const ID = "b6c23ded-cc31-4f56-a8d3-8c2328f417b9";

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });

describe("extractPayload", () => {
  it("reads structuredContent from a live result", () => {
    expect(extractPayload({ content: [], structuredContent: { code: CODE, id: ID } })).toEqual({ code: CODE, id: ID });
  });

  it("prefers structuredContent over the text", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: JSON.stringify({ code: "stale", id: "old" }) }],
      structuredContent: { code: CODE, id: ID },
    };
    expect(extractPayload(result)).toEqual({ code: CODE, id: ID });
  });

  it("recovers source and id from the JSON text a replaying host hands back (Code tab)", () => {
    expect(extractPayload(text(JSON.stringify({ code: CODE, id: ID })))).toEqual({ code: CODE, id: ID });
  });

  it("recovers older results that were saved before ids existed", () => {
    expect(extractPayload(text(JSON.stringify({ code: CODE })))).toEqual({ code: CODE, id: null });
  });

  it("skips non-JSON and non-text blocks until it finds the payload", () => {
    const result: CallToolResult = {
      content: [
        { type: "text", text: "Rendered a diagram." },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: JSON.stringify({ code: CODE, id: ID }) },
      ],
    };
    expect(extractPayload(result)).toEqual({ code: CODE, id: ID });
  });

  it("falls back to a mermaid fence in plain text, without an id", () => {
    expect(extractPayload(text("Rendered a Mermaid diagram.\n```mermaid\n" + CODE + "\n```"))).toEqual({
      code: CODE,
      id: null,
    });
  });

  it("returns null when no source arrived", () => {
    expect(extractPayload({ content: [] })).toBeNull();
    expect(extractPayload(text("Rendered a diagram."))).toBeNull();
    expect(extractPayload(text(JSON.stringify({ ok: true })))).toBeNull();
    expect(extractPayload(text(JSON.stringify({ code: "" })))).toBeNull();
  });
});
