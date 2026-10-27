import { describe, expect, it } from "vitest";
import { folderOptions, projectOptions, ROOT_LABEL } from "./target-options";

const projects = [
  { name: "LLM", folders: ["多模态", "多模态/对比学习", "多模态/对比学习/CLIP", "Transformer"] },
  { name: "医联", folders: [] },
];

describe("projectOptions", () => {
  it("lists the projects in the order given", () => {
    expect(projectOptions(projects, { project: "LLM", folderPath: "" }).map((o) => o.value)).toEqual(["LLM", "医联"]);
  });

  it("keeps a saved default that Mermaid Local doesn't have yet, marked as new", () => {
    const options = projectOptions(projects, { project: "Claude 渲染图", folderPath: "" });
    expect(options.at(-1)).toEqual({ value: "Claude 渲染图", label: "Claude 渲染图（新建）" });
    expect(options).toHaveLength(3);
  });

  it("does not duplicate a default that already exists", () => {
    expect(projectOptions(projects, { project: "医联", folderPath: "" })).toHaveLength(2);
  });

  it("shows the saved default plainly — not as new — when the list could not be loaded", () => {
    expect(projectOptions(null, { project: "LLM", folderPath: "" })).toEqual([{ value: "LLM", label: "LLM" }]);
  });

  it("does mark the default as new when Mermaid Local's list is known to be empty", () => {
    expect(projectOptions([], { project: "LLM", folderPath: "" })).toEqual([{ value: "LLM", label: "LLM（新建）" }]);
  });
});

describe("folderOptions", () => {
  it("puts the project root first, then folders indented by depth", () => {
    const options = folderOptions(projects, "LLM", "");
    expect(options.map((o) => o.value)).toEqual(["", "多模态", "多模态/对比学习", "多模态/对比学习/CLIP", "Transformer"]);
    expect(options[0].label).toBe(ROOT_LABEL);
    expect(options.map((o) => o.label.length - o.label.replace(/^ +/, "").length)).toEqual([0, 0, 4, 8, 0]);
    expect(options[3].label.trim()).toBe("CLIP");
  });

  it("offers only the root for a project without folders or an unknown project", () => {
    expect(folderOptions(projects, "医联", "").map((o) => o.value)).toEqual([""]);
    expect(folderOptions(projects, "不存在", "").map((o) => o.value)).toEqual([""]);
  });

  it("keeps a saved folder that does not exist yet, marked as new", () => {
    const options = folderOptions(projects, "LLM", "新分类/子类");
    expect(options.at(-1)).toEqual({ value: "新分类/子类", label: "新分类/子类（新建）" });
  });

  it("shows the saved folder plainly when the project list could not be loaded", () => {
    expect(folderOptions(null, "LLM", "多模态/对比学习")).toEqual([
      { value: "", label: ROOT_LABEL },
      { value: "多模态/对比学习", label: "多模态/对比学习" },
    ]);
    expect(folderOptions(null, "LLM", "").map((o) => o.value)).toEqual([""]);
  });

  it("does not add the saved folder twice when it exists", () => {
    expect(folderOptions(projects, "LLM", "Transformer")).toHaveLength(5);
  });
});
