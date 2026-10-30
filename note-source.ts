import fs from "node:fs/promises";
import path from "node:path";

/** Mermaid Local's agent-api drops request bodies over 5 MB; leave room for the JSON envelope. */
export const MAX_NOTE_BYTES = 4 * 1024 * 1024;

/** A problem with the content itself, phrased for the model to relay to the user. */
export class NoteSourceError extends Error {}

export interface NoteSource {
  /** The content, re-sent by the model (e.g. an artifact made in a claude.ai chat). */
  text?: string;
  /** Absolute path of a local file (e.g. the file a Code-tab artifact was published from). */
  path?: string;
}

export interface NoteSourceOptions {
  /** Name of the inline parameter, for error messages: `html` for save_html_note, `content` elsewhere. */
  textParam: string;
  /** Require an .html / .htm file (an HTML page is only ever read from one). */
  htmlFile?: boolean;
}

/**
 * The text of a note, from exactly one of its two sources.
 * A local file is preferred by the tool descriptions — it is the content byte for
 * byte and costs no tokens — but a chat-made page only exists in the model's
 * context, so it has to arrive inline.
 */
export async function readNoteSource({ text, path: file }: NoteSource, { textParam, htmlFile = false }: NoteSourceOptions): Promise<string> {
  if ((text === undefined) === (file === undefined)) {
    throw new NoteSourceError(`${textParam} 和 path 必须且只能传一个：本地有文件时传 path，否则传 ${textParam}。`);
  }

  let source: string;
  if (file !== undefined) {
    if (!path.isAbsolute(file)) throw new NoteSourceError(`path 必须是绝对路径：${file}`);
    if (htmlFile && !/\.html?$/i.test(file)) throw new NoteSourceError(`path 必须指向 .html / .htm 文件：${file}`);
    try {
      source = await fs.readFile(file, "utf-8");
    } catch (err) {
      throw new NoteSourceError(`读不到 ${file}：${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    source = text!;
  }

  if (source.trim() === "") throw new NoteSourceError("内容为空。");
  const bytes = Buffer.byteLength(source, "utf-8");
  if (bytes > MAX_NOTE_BYTES) {
    throw new NoteSourceError(`内容有 ${(bytes / 1024 / 1024).toFixed(1)} MB，超过 Mermaid Local 导入上限 4 MB。`);
  }
  return source;
}
