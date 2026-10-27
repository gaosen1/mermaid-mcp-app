/**
 * What a render holds. A Mermaid diagram, or a Markdown document — typically a
 * short write-up whose ```mermaid fences are drawn inline — so a note can carry
 * prose next to the picture. Shared by the server and the viewer, and equal to
 * Mermaid Local's own item types, so the value is passed straight on to it.
 */
export const CONTENT_TYPES = ["mermaid", "markdown"] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

/** Anything else — including renders saved before types existed — is a Mermaid diagram. */
export function parseContentType(value: unknown): ContentType {
  return value === "markdown" ? "markdown" : "mermaid";
}

/** File extension for the stored source, so the file is what its name says. */
export function sourceExtension(type: ContentType): "mmd" | "md" {
  return type === "markdown" ? "md" : "mmd";
}
