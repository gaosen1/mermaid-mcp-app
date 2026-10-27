import type { ImportTarget, TargetProject } from "./targets";

export interface Option {
  value: string;
  label: string;
}

export const ROOT_LABEL = "（项目根目录）";
const NEW_SUFFIX = "（新建）";
const INDENT = "    ";

/**
 * Projects to offer. `projects` is null when Mermaid Local's list couldn't be
 * loaded: then all we know is the saved default, so it is shown as-is — not
 * labelled "new", which would claim it doesn't exist.
 *
 * With a real list, a saved default Mermaid Local doesn't have (yet) stays in
 * the picker marked as new: importing creates it, and dropping it would make
 * the picker silently disagree with what will happen.
 */
export function projectOptions(projects: TargetProject[] | null, current: ImportTarget): Option[] {
  if (projects === null) return [{ value: current.project, label: current.project }];
  const options = projects.map((p) => ({ value: p.name, label: p.name }));
  if (!projects.some((p) => p.name === current.project)) {
    options.push({ value: current.project, label: `${current.project}${NEW_SUFFIX}` });
  }
  return options;
}

/** Folders of one project: the root first, then every folder indented by depth. */
export function folderOptions(projects: TargetProject[] | null, project: string, selectedPath: string): Option[] {
  const options: Option[] = [{ value: "", label: ROOT_LABEL }];
  if (projects === null) {
    if (selectedPath) options.push({ value: selectedPath, label: selectedPath });
    return options;
  }
  const known = projects.find((p) => p.name === project)?.folders ?? [];
  for (const path of known) {
    const segments = path.split("/");
    options.push({ value: path, label: `${INDENT.repeat(segments.length - 1)}${segments[segments.length - 1]}` });
  }
  if (selectedPath && !known.includes(selectedPath)) {
    options.push({ value: selectedPath, label: `${selectedPath}${NEW_SUFFIX}` });
  }
  return options;
}
