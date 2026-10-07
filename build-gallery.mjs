#!/usr/bin/env node
// Standalone local gallery for everything in data/renders/.
//
// This deliberately does NOT go through the ui:// / MCP Apps mechanism at
// all — it's a plain static HTML file you open directly in a browser. That
// makes it immune to anthropics/claude-code#99677 (Code tab dropping _meta
// on replay) by construction: there's no host replaying anything here, just
// a file reading other files next to it.
//
// Each .mmd here is already a directly-importable file for a Mermaid Local
// style notes app (single-file "导入图表" with .mmd extension) — promoting
// a diagram from this ephemeral log into permanent notes is just picking the
// file via that app's own file picker, no bridge code needed on either side.
import fs from "node:fs/promises";
import path from "node:path";

const RENDERS_DIR = path.join(import.meta.dirname, "data", "renders");
const OUT_FILE = path.join(RENDERS_DIR, "index.html");
const VENDOR_DIR = path.join(RENDERS_DIR, "vendor");

// Vendor mermaid's self-contained UMD build locally instead of a CDN <script
// type="module"> import. Two real failures with the CDN/ESM version, found
// by testing this gallery directly rather than assuming: (1) startOnLoad
// races the page's own 'load' event against the async CDN fetch and loses
// more often than not; (2) even after fixing that with an explicit
// mermaid.run(), opening the gallery as a plain file:// (as opposed to this
// script's own localhost test server) leaves it rendering raw source with
// no console error at all — a browser's module loader restricts fetching
// cross-origin modules from a file:// document. A classic, non-module
// <script src="./vendor/mermaid.min.js"> has neither problem: it executes
// synchronously in document order and never leaves its own origin.
await fs.mkdir(VENDOR_DIR, { recursive: true });
await fs.copyFile(
  path.join(import.meta.dirname, "node_modules", "mermaid", "dist", "mermaid.min.js"),
  path.join(VENDOR_DIR, "mermaid.min.js"),
);

const files = await fs.readdir(RENDERS_DIR);
const mmdFiles = files.filter((f) => f.endsWith(".mmd")).sort();

const cards = await Promise.all(
  mmdFiles.map(async (fname) => {
    const id = fname.replace(/\.mmd$/, "");
    const filePath = path.join(RENDERS_DIR, fname);
    const [code, stat] = await Promise.all([fs.readFile(filePath, "utf-8"), fs.stat(filePath)]);

    const metaPath = path.join(RENDERS_DIR, `${id}.json`);
    const meta = await fs
      .readFile(metaPath, "utf-8")
      .then((raw) => JSON.parse(raw))
      .catch(() => null);

    return {
      id,
      code,
      title: meta?.title ?? id,
      createdAt: meta?.createdAt ?? stat.mtime.toISOString(),
    };
  }),
);

cards.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function dayOf(iso) {
  return iso.slice(0, 10);
}

let currentDay = null;
const cardsHtml = cards
  .map((c) => {
    const day = dayOf(c.createdAt);
    const dayHeader = day !== currentDay ? `<h2 class="day">${escapeHtml(day)}</h2>` : "";
    currentDay = day;
    return `
${dayHeader}
    <section class="card">
      <header>
        <span class="title">${escapeHtml(c.title)}</span>
        <span class="meta">${escapeHtml(c.createdAt)} · ${escapeHtml(c.id)}</span>
        <button class="copy-btn" data-id="${escapeHtml(c.id)}">复制源码</button>
      </header>
      <div class="diagram" id="diagram-${escapeHtml(c.id)}">
        <pre class="mermaid">${escapeHtml(c.code)}</pre>
      </div>
      <textarea class="source" id="source-${escapeHtml(c.id)}" hidden>${escapeHtml(c.code)}</textarea>
    </section>`;
  })
  .join("\n");

const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<title>Mermaid 本地图库 (${cards.length})</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #141414; color: #e6e6e6; margin: 0; padding: 24px; }
  h1 { font-size: 18px; color: #9a9a9a; font-weight: 500; }
  h2.day { font-size: 13px; color: #6b6b6b; font-weight: 600; margin: 28px 0 10px; letter-spacing: 0.02em; }
  .card { border: 1px solid #3a3a3a; border-radius: 8px; margin-bottom: 16px; padding: 14px; background: #1e1e1e; }
  .card header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
  .card .title { font-weight: 600; font-size: 14px; }
  .card .meta { color: #6b6b6b; font-size: 11.5px; flex: 1; }
  .copy-btn { font-size: 12px; background: #1e1e1e; color: #e6e6e6; border: 1px solid #3a3a3a; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  .copy-btn:hover { border-color: #9a9a9a; }
  .diagram { overflow-x: auto; }
  .diagram svg { max-width: 100%; }
</style>
</head>
<body>
  <h1>Mermaid 本地图库 — ${cards.length} 张图（不依赖 Claude Desktop 的 MCP Apps 重放）</h1>
  ${cardsHtml}
  <script src="./vendor/mermaid.min.js"></script>
  <script>
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    mermaid.run({ querySelector: ".mermaid" });

    document.querySelectorAll(".copy-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ta = document.getElementById("source-" + btn.dataset.id);
        navigator.clipboard.writeText(ta.value).then(() => {
          const old = btn.textContent;
          btn.textContent = "已复制";
          setTimeout(() => (btn.textContent = old), 1200);
        });
      });
    });
  </script>
</body>
</html>
`;

await fs.writeFile(OUT_FILE, html, "utf-8");
console.log(`Wrote ${OUT_FILE} with ${cards.length} diagrams.`);
