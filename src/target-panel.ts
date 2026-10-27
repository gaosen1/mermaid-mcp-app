import type { App } from "@modelcontextprotocol/ext-apps";
import { folderOptions, projectOptions, type Option } from "./target-options";
import { describeTarget, type ImportTarget, type TargetProject } from "./targets";

interface TargetsResult {
  ok: boolean;
  message: string;
  current: ImportTarget;
  /** Workspace the target belongs to; "" = the shared fallback. */
  scope: string;
  projects: TargetProject[];
}

interface SavedResult {
  ok: boolean;
  message: string;
  current: ImportTarget;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function fill(select: HTMLSelectElement, options: Option[], value: string) {
  select.replaceChildren(
    ...options.map((o) => {
      const el = document.createElement("option");
      el.value = o.value;
      el.textContent = o.label;
      return el;
    }),
  );
  select.value = value;
}

/**
 * The "▾" picker next to "→ Mermaid Local": choose the project and folder that
 * diagrams are imported into. The choice belongs to the workspace this
 * diagram was drawn in (the server looks that up from the render id), and every
 * change is saved immediately as that workspace's default — there's no
 * separate "save" step to forget.
 */
export function initTargetPanel(
  app: App,
  getRenderId: () => string | null,
  onTargetChanged: (target: ImportTarget) => void,
) {
  const toggle = $<HTMLButtonElement>("target-btn");
  const panel = $("target-panel");
  const split = $("target-split");
  const projectSelect = $<HTMLSelectElement>("target-project");
  const folderSelect = $<HTMLSelectElement>("target-folder");
  const status = $("target-status");

  // null = Mermaid Local's list couldn't be loaded (see projectOptions)
  let projects: TargetProject[] | null = null;
  let current: ImportTarget = { project: "", folderPath: "" };

  const say = (text: string, kind: "info" | "ok" | "error" = "info") => {
    status.textContent = text;
    status.title = text;
    status.dataset.kind = kind;
  };

  const whose = (scope: string) => (scope ? `「${scope}」的默认位置` : "当前默认");

  const render = () => {
    fill(projectSelect, projectOptions(projects, current), current.project);
    fill(folderSelect, folderOptions(projects, current.project, current.folderPath), current.folderPath);
  };

  async function load() {
    const id = getRenderId();
    if (!id) return say("还没有可导入的内容", "error");
    say("加载中…");
    projectSelect.disabled = folderSelect.disabled = true;
    try {
      const result = (await app.callServerTool({ name: "list_import_targets", arguments: { id } })).structuredContent as
        | TargetsResult
        | undefined;
      if (!result) throw new Error("服务端没有返回项目列表");
      projects = result.ok ? result.projects : null;
      current = result.current;
      render();
      onTargetChanged(current);
      // Even when the list couldn't be loaded the saved default is shown, so
      // the person can see what imports would do right now.
      if (result.ok) say(`${whose(result.scope)}：${describeTarget(current)}`);
      else say(result.message, "error");
      projectSelect.disabled = folderSelect.disabled = !result.ok;
    } catch (err) {
      say(`加载失败：${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  async function save(next: ImportTarget) {
    const id = getRenderId();
    if (!id) return say("还没有可导入的内容", "error");
    projectSelect.disabled = folderSelect.disabled = true;
    try {
      const result = (await app.callServerTool({ name: "set_import_target", arguments: { id, ...next } }))
        .structuredContent as SavedResult | undefined;
      if (!result?.ok) throw new Error(result?.message ?? "保存失败");
      current = result.current;
      onTargetChanged(current);
      say(result.message, "ok");
    } catch (err) {
      say(`保存失败：${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      render();
      projectSelect.disabled = folderSelect.disabled = false;
    }
  }

  projectSelect.addEventListener("change", () => void save({ project: projectSelect.value, folderPath: "" }));
  folderSelect.addEventListener("change", () =>
    void save({ project: projectSelect.value, folderPath: folderSelect.value }),
  );

  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    // Reload on every open: projects and folders are created in Mermaid Local
    // independently of this viewer.
    if (open) void load();
  };

  toggle.addEventListener("click", () => setOpen(panel.hidden));

  // Dismiss like any popover: a click elsewhere in the widget, or Escape.
  document.addEventListener("pointerdown", (e) => {
    if (!panel.hidden && !split.contains(e.target as Node)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });
}
