import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_NOTE_BYTES, NoteSourceError, readNoteSource } from "./note-source";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "note-source-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const PAGE = "<!doctype html><title>两数之和</title><canvas></canvas>";
const html = { textParam: "html", htmlFile: true };
const any = { textParam: "content" };

describe("readNoteSource", () => {
  it("returns inline text as-is", async () => {
    expect(await readNoteSource({ text: PAGE }, html)).toBe(PAGE);
  });

  it("reads a local file byte for byte", async () => {
    const file = path.join(dir, "two-sum.html");
    fs.writeFileSync(file, PAGE);
    expect(await readNoteSource({ path: file }, html)).toBe(PAGE);
  });

  it("requires exactly one source and names the inline parameter the tool actually has", async () => {
    await expect(readNoteSource({}, html)).rejects.toThrow(/html 和 path 必须且只能传一个/);
    await expect(readNoteSource({ text: PAGE, path: "/x.html" }, any)).rejects.toThrow(/content 和 path 必须且只能传一个/);
  });

  it("rejects relative paths and missing files", async () => {
    await expect(readNoteSource({ path: "two-sum.html" }, html)).rejects.toThrow(/绝对路径/);
    await expect(readNoteSource({ path: path.join(dir, "missing.html") }, html)).rejects.toBeInstanceOf(NoteSourceError);
  });

  it("only insists on .html when the note is an HTML page", async () => {
    const md = path.join(dir, "notes.md");
    fs.writeFileSync(md, "# 标题");
    await expect(readNoteSource({ path: md }, html)).rejects.toThrow(/\.html/);
    expect(await readNoteSource({ path: md }, any)).toBe("# 标题");
  });

  it("rejects empty and oversized content", async () => {
    await expect(readNoteSource({ text: "  \n" }, any)).rejects.toThrow(/为空/);
    await expect(readNoteSource({ text: "x".repeat(MAX_NOTE_BYTES + 1) }, any)).rejects.toThrow(/超过/);
  });
});
