import { describe, expect, it } from "vitest";
import { parseContentType, sourceExtension } from "./content-type";

describe("parseContentType", () => {
  it("accepts both known types", () => {
    expect(parseContentType("mermaid")).toBe("mermaid");
    expect(parseContentType("markdown")).toBe("markdown");
  });

  it("treats everything else, including a missing type, as mermaid", () => {
    for (const value of [undefined, null, "", "md", "MARKDOWN", 7, {}]) {
      expect(parseContentType(value)).toBe("mermaid");
    }
  });
});

describe("sourceExtension", () => {
  it("names each stored source file by what it holds", () => {
    expect(sourceExtension("mermaid")).toBe("mmd");
    expect(sourceExtension("markdown")).toBe("md");
  });
});
