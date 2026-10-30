import type { LibraryItem } from "./mermaid-local.js";

/** Renders a project's tree as an outline: folders show their full path (what the organize actions take), notes their type, title and id. */
export function renderLibrary(projects: { name: string; items: LibraryItem[] }[]): string {
  const lines: string[] = [];
  for (const project of projects) {
    lines.push(`项目「${project.name}」`);
    const walk = (items: LibraryItem[], parentPath: string, depth: number) => {
      const indent = "  ".repeat(depth);
      for (const item of items) {
        if (item.kind === "folder") {
          const folderPath = parentPath ? `${parentPath}/${item.name}` : item.name;
          lines.push(`${indent}📁 ${folderPath}/${item.items.length === 0 ? "  (空)" : ""}`);
          walk(item.items, folderPath, depth + 1);
        } else {
          lines.push(`${indent}[${item.type}] ${item.name}  (id: ${item.id.slice(0, 8)})`);
        }
      }
    };
    if (project.items.length === 0) lines.push("  (空)");
    walk(project.items, "", 1);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
