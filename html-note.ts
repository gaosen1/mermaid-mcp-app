import fs from "node:fs/promises";
import path from "node:path";

/** Mermaid Local's agent-api drops request bodies over 5 MB; leave room for the JSON envelope. */
export const MAX_HTML_BYTES = 4 * 1024 * 1024;

/** A problem with the page itself, phrased for the model to relay to the user. */
export class HtmlNoteError extends Error {}

export interface HtmlNoteSource {
  /** The page's full HTML, re-sent by the model (e.g. an artifact made in a claude.ai chat). */
  html?: string;
  /** Absolute path of a local .html file (e.g. the file a Code-tab artifact was published from). */
  path?: string;
}

/**
 * The HTML of a page the user wants kept, from exactly one of its two sources.
 * A local file is preferred by the tool description — it is the page byte for
 * byte and costs no tokens — but a chat-made page only exists in the model's
 * context, so it has to arrive inline.
 */
export async function readHtmlNote({ html, path: file }: HtmlNoteSource): Promise<string> {
  if ((html === undefined) === (file === undefined)) {
    throw new HtmlNoteError("html 和 path 必须且只能传一个：本地有文件时传 path，否则传 html。");
  }

  let source: string;
  if (file !== undefined) {
    if (!path.isAbsolute(file)) throw new HtmlNoteError(`path 必须是绝对路径：${file}`);
    if (!/\.html?$/i.test(file)) throw new HtmlNoteError(`path 必须指向 .html / .htm 文件：${file}`);
    try {
      source = await fs.readFile(file, "utf-8");
    } catch (err) {
      throw new HtmlNoteError(`读不到 ${file}：${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    source = html!;
  }

  if (source.trim() === "") throw new HtmlNoteError("HTML 内容为空。");
  const bytes = Buffer.byteLength(source, "utf-8");
  if (bytes > MAX_HTML_BYTES) {
    throw new HtmlNoteError(`HTML 有 ${(bytes / 1024 / 1024).toFixed(1)} MB，超过 Mermaid Local 导入上限 4 MB。`);
  }
  return source;
}
