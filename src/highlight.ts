import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Core + an explicit language list rather than the full bundle: the viewer ships
// as one inlined HTML file, so every registered grammar costs bytes in it.
const LANGUAGES = {
  bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin,
  markdown, php, python, ruby, rust, scss, sql, swift, typescript, xml, yaml,
};
for (const [name, grammar] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, grammar);

export interface HighlightedCode {
  /** Token `<span class="hljs-*">` markup; the source text is escaped. */
  html: string;
  /** The grammar name or alias that matched a registered grammar, so safe to put in a class attribute. */
  language: string;
}

/**
 * Highlights a fence's code, or returns null when the fence names no language we
 * have a grammar for — the caller then renders it as plain code. Aliases such as
 * `ts`, `sh`, `html` and `yml` resolve through highlight.js.
 */
export function highlightCode(text: string, lang: string | undefined): HighlightedCode | null {
  const name = lang?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!name || !hljs.getLanguage(name)) return null;
  const { value } = hljs.highlight(text, { language: name, ignoreIllegals: true });
  return { html: value, language: name };
}
