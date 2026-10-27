import { Marked } from "marked";

export interface MarkdownRender {
  /** HTML for the document; each mermaid fence is a placeholder to be replaced by its diagram. */
  html: string;
  /** Source of every ```mermaid fence, in document order; placeholder `i` stands for `diagrams[i]`. */
  diagrams: string[];
}

/** Attribute on the placeholder element that says which `diagrams` entry belongs there. */
export const DIAGRAM_INDEX_ATTR = "data-md-diagram";

/**
 * Markdown -> HTML, with ```mermaid fences held out as placeholders rather than
 * emitted as code: Mermaid needs a DOM to draw, so the viewer renders those
 * itself. The result is NOT sanitized — markdown may carry raw HTML, so the
 * caller must sanitize before inserting it (DOM-dependent, hence not here).
 */
export function renderMarkdown(source: string): MarkdownRender {
  const diagrams: string[] = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      code({ text, lang }) {
        if (lang?.trim().toLowerCase() !== "mermaid") return false; // default rendering
        const index = diagrams.push(text) - 1;
        return `<div class="md-diagram" ${DIAGRAM_INDEX_ATTR}="${index}"></div>\n`;
      },
    },
  });
  return { html: marked.parse(source, { async: false }), diagrams };
}
