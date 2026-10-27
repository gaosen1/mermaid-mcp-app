import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HtmlNoteError, MAX_HTML_BYTES, readHtmlNote } from "./html-note";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "html-note-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const PAGE = "<!doctype html><title>两数之和</title><canvas></canvas>";

describe("readHtmlNote", () => {
  it("returns inline html as-is", async () => {
    expect(await readHtmlNote({ html: PAGE })).toBe(PAGE);
  });

  it("reads a local .html file byte for byte", async () => {
    const file = path.join(dir, "two-sum.html");
    fs.writeFileSync(file, PAGE);
    expect(await readHtmlNote({ path: file })).toBe(PAGE);
  });

  it("requires exactly one source", async () => {
    await expect(readHtmlNote({})).rejects.toThrow(/只能传一个/);
    await expect(readHtmlNote({ html: PAGE, path: "/x.html" })).rejects.toThrow(/只能传一个/);
  });

  it("rejects relative paths, non-html files and missing files", async () => {
    await expect(readHtmlNote({ path: "two-sum.html" })).rejects.toThrow(/绝对路径/);
    await expect(readHtmlNote({ path: path.join(dir, "notes.md") })).rejects.toThrow(/\.html/);
    await expect(readHtmlNote({ path: path.join(dir, "missing.html") })).rejects.toBeInstanceOf(HtmlNoteError);
  });

  it("rejects empty and oversized pages", async () => {
    await expect(readHtmlNote({ html: "  \n" })).rejects.toThrow(/为空/);
    await expect(readHtmlNote({ html: "x".repeat(MAX_HTML_BYTES + 1) })).rejects.toThrow(/超过/);
  });
});
