import { describe, expect, it } from "vitest";
import { DIAGRAM_INDEX_ATTR, renderMarkdown } from "./markdown";

const MERMAID = "flowchart LR\n  A --> B";
const fence = (body: string, lang = "mermaid") => "```" + lang + "\n" + body + "\n```";

describe("renderMarkdown", () => {
  it("renders ordinary GFM: headings, emphasis, lists, tables", () => {
    const { html, diagrams } = renderMarkdown(
      ["# 标题", "", "一段 **加粗** 文字。", "", "- 甲", "- 乙", "", "| 列 | 值 |", "| --- | --- |", "| a | 1 |"].join("\n"),
    );
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<li>甲</li>");
    expect(html).toContain("<table>");
    expect(diagrams).toEqual([]);
  });

  it("holds a mermaid fence out as a placeholder and returns its source", () => {
    const { html, diagrams } = renderMarkdown(`前言\n\n${fence(MERMAID)}\n\n后记`);
    expect(diagrams).toEqual([MERMAID]);
    expect(html).toContain(`<div class="md-diagram" ${DIAGRAM_INDEX_ATTR}="0"></div>`);
    expect(html).not.toContain("flowchart");
    expect(html).toContain("<p>前言</p>");
    expect(html).toContain("<p>后记</p>");
  });

  it("numbers several diagrams in document order, matching their sources", () => {
    const { html, diagrams } = renderMarkdown([fence("flowchart LR\nA-->B"), "中间文字", fence("sequenceDiagram\nA->>B: hi")].join("\n\n"));
    expect(diagrams).toEqual(["flowchart LR\nA-->B", "sequenceDiagram\nA->>B: hi"]);
    expect(html.indexOf(`${DIAGRAM_INDEX_ATTR}="0"`)).toBeLessThan(html.indexOf(`${DIAGRAM_INDEX_ATTR}="1"`));
  });

  it("finds a fence nested inside a list item", () => {
    const { html, diagrams } = renderMarkdown(`1. 第一步\n\n   ${fence(MERMAID).replace(/\n/g, "\n   ")}\n\n2. 第二步`);
    expect(diagrams).toEqual([MERMAID]);
    expect(html).toContain(`${DIAGRAM_INDEX_ATTR}="0"`);
  });

  it("matches the language case-insensitively and ignores surrounding whitespace", () => {
    expect(renderMarkdown(fence(MERMAID, "Mermaid")).diagrams).toEqual([MERMAID]);
    expect(renderMarkdown("```mermaid \n" + MERMAID + "\n```").diagrams).toEqual([MERMAID]);
  });

  it("leaves other code blocks as ordinary code", () => {
    const { html, diagrams } = renderMarkdown(fence("const a = 1", "nosuchlang"));
    expect(diagrams).toEqual([]);
    expect(html).toContain("<pre><code");
    expect(html).toContain("const a = 1");
  });

  it("syntax-highlights a fence whose language has a grammar, resolving aliases", () => {
    const { html, diagrams } = renderMarkdown(fence("const a: number = 1;", "ts"));
    expect(diagrams).toEqual([]);
    expect(html).toContain('<code class="hljs language-ts">');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('<span class="hljs-number">1</span>');
  });

  it("escapes code text while highlighting, so it cannot inject markup", () => {
    const { html } = renderMarkdown(fence('<img src=x onerror="alert(1)">', "html"));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;");
  });

  it("highlights by the first word of the info string", () => {
    expect(renderMarkdown(fence("echo hi", "bash title=run.sh")).html).toContain("language-bash");
  });

  it("leaves a fence with an unknown or missing language as plain code", () => {
    for (const lang of ["nosuchlang", ""]) {
      const { html } = renderMarkdown(fence("let x = 1", lang));
      expect(html).not.toContain("hljs");
    }
  });

  it("does not treat inline code or a plain fence as a diagram", () => {
    const { diagrams } = renderMarkdown("文中的 `mermaid` 只是词。\n\n```\nflowchart LR\n```");
    expect(diagrams).toEqual([]);
  });

  it("does not leak state between calls", () => {
    renderMarkdown(fence(MERMAID));
    expect(renderMarkdown("纯文字").diagrams).toEqual([]);
    expect(renderMarkdown(fence("graph TD\nX-->Y")).diagrams).toEqual(["graph TD\nX-->Y"]);
  });

  it("passes raw HTML through untouched — sanitizing is the caller's job", () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)">').html).toContain("onerror");
  });
});
