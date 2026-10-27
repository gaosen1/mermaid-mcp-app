import { describe, expect, it } from "vitest";
import { describeTarget, normalizeFolderPath } from "./targets";

describe("normalizeFolderPath", () => {
  it("trims segments and drops empty ones", () => {
    expect(normalizeFolderPath("a/b")).toBe("a/b");
    expect(normalizeFolderPath(" a / b/ ")).toBe("a/b");
    expect(normalizeFolderPath("//a//b//")).toBe("a/b");
  });

  it("maps blank input to the project root", () => {
    expect(normalizeFolderPath("")).toBe("");
    expect(normalizeFolderPath("  /  ")).toBe("");
  });
});

describe("describeTarget", () => {
  it("shows only the project for the root", () => {
    expect(describeTarget({ project: "LLM", folderPath: "" })).toBe("LLM");
  });

  it("joins project and folders", () => {
    expect(describeTarget({ project: "LLM", folderPath: "多模态与跨模态/对比学习" })).toBe("LLM / 多模态与跨模态 / 对比学习");
  });
});
