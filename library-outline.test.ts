import { describe, expect, it } from "vitest";
import { renderLibrary } from "./library-outline";

describe("renderLibrary", () => {
  it("prints folders with their full path and notes with type, title and a short id, indented by depth", () => {
    expect(
      renderLibrary([
        {
          name: "算法笔记",
          items: [
            { kind: "note", id: "986165f7-5961-4ee8-b225-d6deb6ac8ac8", name: "Alpha", type: "html" },
            {
              kind: "folder",
              name: "算法",
              items: [
                { kind: "folder", name: "排序", items: [{ kind: "note", id: "c2cdb76b-c4db-4ac5-a76d-ec255da36296", name: "归并", type: "markdown" }] },
                { kind: "folder", name: "空的", items: [] },
              ],
            },
          ],
        },
        { name: "空项目", items: [] },
      ]),
    ).toBe(
      [
        "项目「算法笔记」",
        "  [html] Alpha  (id: 986165f7)",
        "  📁 算法/",
        "    📁 算法/排序/",
        "      [markdown] 归并  (id: c2cdb76b)",
        "    📁 算法/空的/  (空)",
        "",
        "项目「空项目」",
        "  (空)",
      ].join("\n"),
    );
  });
});
