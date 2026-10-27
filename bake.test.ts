import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { BAKE_MARKER, bakeInitialState } from "./bake";

const render = { id: "id-1", type: "markdown" as const, source: "# 标题", title: "说明" };
const page = (middle = "") => `<html><head>${middle}${BAKE_MARKER}</head><body></body></html>`;

/** Runs the baked <script> the way a browser would and returns the globals it sets. */
function bakedGlobals(html: string): Record<string, unknown> {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(script, sandbox);
  return sandbox.window;
}

describe("bakeInitialState", () => {
  it("exposes source, id, title and type to the page", () => {
    expect(bakedGlobals(bakeInitialState(page(), render))).toEqual({
      __MERMAID_INITIAL_CODE__: "# 标题",
      __MERMAID_INITIAL_ID__: "id-1",
      __MERMAID_INITIAL_TITLE__: "说明",
      __MERMAID_INITIAL_TYPE__: "markdown",
    });
  });

  it("passes a missing title through as null", () => {
    expect(bakedGlobals(bakeInitialState(page(), { ...render, title: null })).__MERMAID_INITIAL_TITLE__).toBeNull();
  });

  it("replaces the marker and nothing else", () => {
    const out = bakeInitialState(page("<title>t</title>"), render);
    expect(out).not.toContain(BAKE_MARKER);
    expect(out.startsWith("<html><head><title>t</title><script>")).toBe(true);
    expect(out.endsWith("</head><body></body></html>")).toBe(true);
  });

  it("is not fooled by a </head> inside the page's own inlined JS", () => {
    const decoy = `<script type="module">const x='<html><head></head><body>'</script>`;
    const out = bakeInitialState(page(decoy), render);
    expect(out).toContain(`const x='<html><head></head><body>'</script>`); // the library code is untouched
    expect(bakedGlobals(out).__MERMAID_INITIAL_CODE__).toBe("# 标题");
  });

  it("cannot be broken out of by a </script> in the source", () => {
    const hostile = 'x</script><img src=x onerror="alert(1)"><script>y';
    const out = bakeInitialState(page(), { ...render, source: hostile, title: hostile });
    expect(out.match(/<\/script>/g)).toHaveLength(1); // only the baked block's own closing tag
    expect(out).not.toContain("<img");
    const globals = bakedGlobals(out);
    expect(globals.__MERMAID_INITIAL_CODE__).toBe(hostile);
    expect(globals.__MERMAID_INITIAL_TITLE__).toBe(hostile);
  });

  it("keeps $-sequences in the source literal", () => {
    const source = "a $& b $' c $` d $1 e $$";
    expect(bakedGlobals(bakeInitialState(page(), { ...render, source })).__MERMAID_INITIAL_CODE__).toBe(source);
  });

  it("keeps newlines, quotes and unicode line separators intact", () => {
    const source = 'line1\nline2 "quoted" \'single\'     \\ backslash';
    expect(bakedGlobals(bakeInitialState(page(), { ...render, source })).__MERMAID_INITIAL_CODE__).toBe(source);
  });

  it.each([
    ["missing", "<html><head></head></html>"],
    ["duplicated", `${BAKE_MARKER}${BAKE_MARKER}`],
  ])("throws when the marker is %s", (_name, html) => {
    expect(() => bakeInitialState(html, render)).toThrow(/exactly once/);
  });
});

describe("the built viewer", () => {
  const built = path.join(import.meta.dirname, "dist", "mcp-app.html");

  it.skipIf(!fs.existsSync(built))("contains the marker exactly once, in the real <head>", () => {
    const html = fs.readFileSync(built, "utf-8");
    expect(html.split(BAKE_MARKER)).toHaveLength(2);
    // between <head> and the real </head> — i.e. before the <body> that holds the app
    expect(html.indexOf(BAKE_MARKER)).toBeLessThan(html.lastIndexOf("<body>"));
    expect(html.indexOf(BAKE_MARKER)).toBeLessThan(html.lastIndexOf("</head>"));
    expect(html.lastIndexOf("</head>")).toBeLessThan(html.lastIndexOf("<body>"));
  });
});
