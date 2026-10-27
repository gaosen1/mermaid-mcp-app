import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { extractPayload } from "./extract";

const CODE = "flowchart LR\nA[开始] --> B[结束]";
const ID = "b6c23ded-cc31-4f56-a8d3-8c2328f417b9";
const TITLE = "登录鉴权流程";

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });

describe("extractPayload", () => {
  it("reads structuredContent from a live result", () => {
    expect(extractPayload({ content: [], structuredContent: { code: CODE, id: ID, title: TITLE } })).toEqual({
      code: CODE,
      type: "mermaid",
      id: ID,
      title: TITLE,
    });
  });

  it("prefers structuredContent over the text", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: JSON.stringify({ code: "stale", id: "old" }) }],
      structuredContent: { code: CODE, id: ID },
    };
    expect(extractPayload(result)).toEqual({ code: CODE, type: "mermaid", id: ID, title: null });
  });

  it("recovers source, id and title from the JSON text a replaying host hands back (Code tab)", () => {
    expect(extractPayload(text(JSON.stringify({ code: CODE, id: ID, title: TITLE })))).toEqual({
      code: CODE,
      id: ID,
      title: TITLE,
      type: "mermaid",
    });
  });

  it("treats a missing or empty title as null", () => {
    expect(extractPayload(text(JSON.stringify({ code: CODE, id: ID })))?.title).toBeNull();
    expect(extractPayload(text(JSON.stringify({ code: CODE, id: ID, title: "" })))?.title).toBeNull();
    expect(extractPayload(text(JSON.stringify({ code: CODE, id: ID, title: 42 })))?.title).toBeNull();
  });

  it("recovers older results that were saved before ids existed", () => {
    expect(extractPayload(text(JSON.stringify({ code: CODE })))).toEqual({ code: CODE, type: "mermaid", id: null, title: null });
  });

  it("skips non-JSON and non-text blocks until it finds the payload", () => {
    const result: CallToolResult = {
      content: [
        { type: "text", text: "Rendered a diagram." },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: JSON.stringify({ code: CODE, id: ID }) },
      ],
    };
    expect(extractPayload(result)).toEqual({ code: CODE, type: "mermaid", id: ID, title: null });
  });

  it("falls back to a mermaid fence in plain text, without an id", () => {
    expect(extractPayload(text("Rendered a Mermaid diagram.\n```mermaid\n" + CODE + "\n```"))).toEqual({
      code: CODE,
      type: "mermaid",
      id: null,
      title: null,
    });
  });

  it("reads the content type from a live result and from replayed JSON text", () => {
    const doc = "# 说明\n\n```mermaid\nflowchart LR\nA-->B\n```";
    expect(extractPayload({ content: [], structuredContent: { code: doc, id: ID, title: TITLE, type: "markdown" } })).toEqual({
      code: doc,
      type: "markdown",
      id: ID,
      title: TITLE,
    });
    expect(extractPayload(text(JSON.stringify({ code: doc, id: ID, title: TITLE, type: "markdown" })))?.type).toBe("markdown");
  });

  it("treats a missing or unknown type as mermaid, so results saved before types existed still draw", () => {
    expect(extractPayload(text(JSON.stringify({ code: CODE, id: ID })))?.type).toBe("mermaid");
    expect(extractPayload(text(JSON.stringify({ code: CODE, id: ID, type: "html" })))?.type).toBe("mermaid");
  });

  it("returns null when no source arrived", () => {
    expect(extractPayload({ content: [] })).toBeNull();
    expect(extractPayload(text("Rendered a diagram."))).toBeNull();
    expect(extractPayload(text(JSON.stringify({ ok: true })))).toBeNull();
    expect(extractPayload(text(JSON.stringify({ code: "" })))).toBeNull();
  });
});
