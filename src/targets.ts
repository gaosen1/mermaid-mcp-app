/**
 * Where an imported diagram lands in Mermaid Local: a project plus a folder
 * path inside it ("a/b"; "" is the project root). Shared by the MCP server and
 * the viewer, so it stays free of Node and DOM APIs.
 */
export interface ImportTarget {
  project: string;
  folderPath: string;
}

/** One project and every folder path under it, as Mermaid Local lists them. */
export interface TargetProject {
  name: string;
  folders: string[];
}

/** "  a / b/ " -> "a/b"; blank -> "" (project root). */
export function normalizeFolderPath(path: string): string {
  return path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

/** "LLM" for the root, "LLM / 多模态 / 对比学习" otherwise. */
export function describeTarget(target: ImportTarget): string {
  const folders = target.folderPath ? target.folderPath.split("/") : [];
  return [target.project, ...folders].join(" / ");
}
