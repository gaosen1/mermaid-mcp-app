/**
 * Mermaid Viewer — the View half of the render_mermaid MCP App.
 *
 * Receives Mermaid source via the render_mermaid tool's structuredContent,
 * renders it client-side with Mermaid (the only place Mermaid's parser can
 * actually run, since it needs a DOM), and shows a clear error instead of a
 * blank page when the source doesn't parse. Also provides pan/zoom, a
 * fit-to-width default (so diagrams aren't tiny), a fullscreen request, and
 * copying the raw source, since the host chat surface alone doesn't give the
 * user any of that.
 */
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/client";
import mermaid from "mermaid";
import "./mcp-app.css";

const statusEl = document.getElementById("status")!;
const toolbarEl = document.getElementById("toolbar")!;
const zoomOutBtn = document.getElementById("zoom-out") as HTMLButtonElement;
const zoomInBtn = document.getElementById("zoom-in") as HTMLButtonElement;
const zoomResetBtn = document.getElementById("zoom-reset") as HTMLButtonElement;
const zoomLevelEl = document.getElementById("zoom-level")!;
const fullscreenBtn = document.getElementById("fullscreen-btn") as HTMLButtonElement;
const copyBtn = document.getElementById("copy-btn") as HTMLButtonElement;
const viewportEl = document.getElementById("viewport")!;
const panZoomEl = document.getElementById("pan-zoom")!;
const errorEl = document.getElementById("error")!;
const errorMessageEl = document.getElementById("error-message")!;
const errorSourceEl = document.getElementById("error-source-code")!;

let renderCount = 0;
let lastCode: string | null = null;

// ---- Theme -----------------------------------------------------------

function initMermaid(theme: "light" | "dark") {
  mermaid.initialize({
    startOnLoad: false,
    // Strict security: sanitizes labels/HTML in diagram source and disables
    // script/click bindings. We never execute anything from the diagram text.
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "default",
    fontFamily: "inherit",
  });
}

// ---- Pan / zoom --------------------------------------------------------

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

let baseScale = 1;
let scale = 1;
let naturalWidth = 0;
let naturalHeight = 0;
let userAdjusted = false;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function updateZoomLabel() {
  const pct = baseScale > 0 ? Math.round((scale / baseScale) * 100) : 100;
  zoomLevelEl.textContent = `${pct}%`;
}

// Sets the SVG's own real layout size (not a CSS transform) — see the
// comment on .viewport in mcp-app.css for why: transform+overflow:hidden
// didn't reliably clip in every host, so sizing is real and overflow is
// handled by the browser's native scrolling instead.
function applySvgWidth(widthPx: number) {
  const svg = panZoomEl.querySelector("svg") as SVGSVGElement | null;
  if (!svg || naturalWidth <= 0) return;
  const clampedWidth = clamp(widthPx, naturalWidth * MIN_SCALE, naturalWidth * MAX_SCALE);
  const heightPx = clampedWidth * (naturalHeight / naturalWidth);
  svg.style.width = `${clampedWidth}px`;
  svg.style.height = `${heightPx}px`;
  scale = clampedWidth / naturalWidth;
  updateZoomLabel();
}

function getSvgNaturalSize(svg: SVGSVGElement): { width: number; height: number } {
  const vb = svg.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { width: vb.width, height: vb.height };
  const w = parseFloat(svg.getAttribute("width") ?? "");
  const h = parseFloat(svg.getAttribute("height") ?? "");
  if (w > 0 && h > 0) return { width: w, height: h };
  const bbox = svg.getBBox();
  return { width: bbox.width || 300, height: bbox.height || 150 };
}

const VIEWPORT_MIN_HEIGHT = 160;
// A comfortable viewing window, not a hard content limit — pan/zoom already
// exist for diagrams taller than this, so the box caps out at a reasonable
// widget size instead of growing to match arbitrarily tall content.
const VIEWPORT_MAX_HEIGHT = 640;

function fitToWidth() {
  const svg = panZoomEl.querySelector("svg") as SVGSVGElement | null;
  if (!svg) return;
  const size = getSvgNaturalSize(svg);
  naturalWidth = size.width;
  naturalHeight = size.height;

  const viewportWidth = viewportEl.clientWidth || naturalWidth;

  // Scale by WIDTH ONLY (never by a capped box height — that shrinks tall
  // diagrams down to illegible text just to dodge a scrollbar; pan exists
  // precisely so that trade-off is never necessary), but never scale ABOVE
  // the diagram's own natural size either: Mermaid already renders at a
  // comfortable, readable size, so a small/simple diagram in a wide chat
  // panel must not get stretched to fill the full width — that blows it up
  // to a giant, oversized render instead of a readable one. Only shrink to
  // fit when the diagram is naturally wider than the container.
  const widthScale = viewportWidth / naturalWidth;
  baseScale = clamp(Math.min(widthScale, 1), MIN_SCALE, MAX_SCALE);

  applySvgWidth(naturalWidth * baseScale);

  // The box itself just needs to be a sane viewing window: short diagrams
  // get a snugly-fit box (no dead space below them), tall ones cap out and
  // rely on the pan/zoom (now native scroll) the toolbar already provides.
  const renderedHeight = naturalHeight * baseScale;
  viewportEl.style.height = `${clamp(renderedHeight, VIEWPORT_MIN_HEIGHT, VIEWPORT_MAX_HEIGHT)}px`;

  viewportEl.scrollLeft = 0;
  viewportEl.scrollTop = 0;
  userAdjusted = false;
}

function zoomAt(px: number, py: number, factor: number) {
  const svg = panZoomEl.querySelector("svg") as SVGSVGElement | null;
  if (!svg) return;
  const oldWidthPx = parseFloat(svg.style.width) || naturalWidth * scale;

  // Keep the point under the cursor/anchor visually stationary: convert it
  // to content-space coordinates before resizing, then re-derive the scroll
  // offset that puts that same content point back under the anchor after.
  const contentX = viewportEl.scrollLeft + px;
  const contentY = viewportEl.scrollTop + py;

  applySvgWidth(oldWidthPx * factor);
  const actualFactor = (parseFloat(svg.style.width) || oldWidthPx) / oldWidthPx;

  viewportEl.scrollLeft = contentX * actualFactor - px;
  viewportEl.scrollTop = contentY * actualFactor - py;
  userAdjusted = true;
}

function zoomAtCenter(factor: number) {
  zoomAt(viewportEl.clientWidth / 2, viewportEl.clientHeight / 2, factor);
}

zoomInBtn.addEventListener("click", () => zoomAtCenter(1.25));
zoomOutBtn.addEventListener("click", () => zoomAtCenter(1 / 1.25));
zoomResetBtn.addEventListener("click", () => fitToWidth());

viewportEl.addEventListener(
  "wheel",
  (e) => {
    if (viewportEl.hidden) return;
    // Only zoom while Cmd/Ctrl is held (Ctrl doubles as what browsers set
    // for a trackpad pinch gesture). A plain wheel scroll is left alone so
    // it falls through to the surrounding chat's normal scroll — otherwise
    // scrolling past the diagram while reading the conversation silently
    // turns into zooming instead. (A plain scroll here still natively
    // scrolls the viewport box itself first, which is the point.)
    if (!e.metaKey && !e.ctrlKey) return;
    e.preventDefault();
    const rect = viewportEl.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
  },
  { passive: false },
);

let panPointerId: number | null = null;
let panStart = { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 };

viewportEl.addEventListener("pointerdown", (e) => {
  panPointerId = e.pointerId;
  panStart = {
    x: e.clientX,
    y: e.clientY,
    scrollLeft: viewportEl.scrollLeft,
    scrollTop: viewportEl.scrollTop,
  };
  viewportEl.classList.add("panning");
  viewportEl.setPointerCapture(e.pointerId);
});

viewportEl.addEventListener("pointermove", (e) => {
  if (panPointerId !== e.pointerId) return;
  viewportEl.scrollLeft = panStart.scrollLeft - (e.clientX - panStart.x);
  viewportEl.scrollTop = panStart.scrollTop - (e.clientY - panStart.y);
  userAdjusted = true;
});

function endPan(e: PointerEvent) {
  if (panPointerId !== e.pointerId) return;
  panPointerId = null;
  viewportEl.classList.remove("panning");
  try {
    viewportEl.releasePointerCapture(e.pointerId);
  } catch {
    // already released
  }
}
viewportEl.addEventListener("pointerup", endPan);
viewportEl.addEventListener("pointercancel", endPan);

// Guard against a self-triggered feedback loop: fitToWidth() sets
// viewportEl's own height, which — via the host's autoResize reacting to
// the resulting body-height change and adjusting the iframe, which can
// perturb the container's resolved width by a hair (e.g. a scrollbar
// toggling) — can re-fire this same observer, which calls fitToWidth()
// again, which changes the height again... each round growing the box a
// bit more, forever. Only react when the WIDTH actually changed; a
// height-only change is either our own write or irrelevant to the fit.
let lastObservedWidth = 0;

// Belt-and-suspenders circuit breaker: even with the width-only guard
// above, cap how many times a burst of resize events can trigger a refit
// so a loop neither of us has fully diagnosed can't grow the box forever.
let refitBurstCount = 0;
let refitBurstResetTimer: ReturnType<typeof setTimeout> | undefined;

new ResizeObserver((entries) => {
  const width = entries[0]?.contentRect.width ?? viewportEl.clientWidth;
  if (Math.abs(width - lastObservedWidth) < 1) return;
  lastObservedWidth = width;
  if (userAdjusted || panZoomEl.hidden || !panZoomEl.querySelector("svg")) return;

  clearTimeout(refitBurstResetTimer);
  refitBurstResetTimer = setTimeout(() => {
    refitBurstCount = 0;
  }, 2000);
  if (++refitBurstCount > 5) return;

  fitToWidth();
}).observe(viewportEl);

// ---- Copy source --------------------------------------------------------

let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

const COPY_LABEL = "⧉ 复制源码";

async function tryClipboardApi(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function tryExecCommand(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

function flashCopyLabel(text: string, revertAfterMs = 1600) {
  copyBtn.textContent = text;
  clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = setTimeout(() => {
    copyBtn.textContent = COPY_LABEL;
  }, revertAfterMs);
}

async function copySource() {
  if (!lastCode) return;

  const ok = (await tryClipboardApi(lastCode)) || tryExecCommand(lastCode);

  if (ok) {
    flashCopyLabel("已复制 ✓");
  } else {
    // Host blocks clipboard access from this sandboxed iframe (common —
    // it's a host permissions-policy decision, not something we control).
    // window.prompt's text field is a native OS control, unaffected by that
    // policy, and needs no permanent on-page space: the user can select-all
    // and Cmd/Ctrl+C from it directly.
    window.prompt("无法直接写入剪贴板，请手动复制以下内容：", lastCode);
  }
}
copyBtn.addEventListener("click", () => void copySource());

// ---- Fullscreen ---------------------------------------------------------

let currentDisplayMode: string | undefined;

function updateFullscreenButton(ctx: McpUiHostContext) {
  const available = ctx.availableDisplayModes ?? [];
  currentDisplayMode = ctx.displayMode;
  if (available.includes("fullscreen")) {
    fullscreenBtn.hidden = false;
    fullscreenBtn.textContent = currentDisplayMode === "fullscreen" ? "⤡ 退出全屏" : "⤢ 全屏";
  } else {
    fullscreenBtn.hidden = true;
  }
}

fullscreenBtn.addEventListener("click", async () => {
  const target = currentDisplayMode === "fullscreen" ? "inline" : "fullscreen";
  try {
    await app.requestDisplayMode({ mode: target });
  } catch (err) {
    console.error("requestDisplayMode failed:", err);
  }
});

// ---- Rendering ------------------------------------------------------------

function showStatus(text: string) {
  statusEl.textContent = text;
  statusEl.hidden = false;
  toolbarEl.hidden = true;
  viewportEl.hidden = true;
  errorEl.hidden = true;
}

function showError(message: string, code: string) {
  statusEl.hidden = true;
  toolbarEl.hidden = true;
  viewportEl.hidden = true;
  errorEl.hidden = false;
  errorMessageEl.textContent = message;
  errorSourceEl.textContent = code;
}

function showDiagram(svg: string) {
  statusEl.hidden = true;
  errorEl.hidden = true;
  toolbarEl.hidden = false;
  viewportEl.hidden = false;

  panZoomEl.innerHTML = svg;

  // Wait a frame so the viewport has real layout dimensions before fitting.
  // The host's own container can still be settling its width right after
  // mount, so a second pass shortly after catches that without needing the
  // user to nudge anything (the ResizeObserver below handles later resizes).
  requestAnimationFrame(() => {
    fitToWidth();
    setTimeout(() => {
      if (!userAdjusted) fitToWidth();
    }, 200);
  });
}

async function renderMermaid(code: string) {
  lastCode = code;
  showStatus("Rendering diagram…");

  try {
    // Validates syntax up front so parse errors surface with Mermaid's own
    // message rather than a generic render failure.
    await mermaid.parse(code);
    const id = `mermaid-view-${++renderCount}`;
    const { svg } = await mermaid.render(id, code);
    showDiagram(svg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showError(message, code);
  }
}

function extractCode(result: CallToolResult): string | null {
  const structured = result.structuredContent as { code?: string } | undefined;
  if (structured?.code) return structured.code;

  // Fallback for the text-only path, in case a host ever delivers only
  // `content` without `structuredContent`.
  const text = result.content?.find((c) => c.type === "text")?.text;
  const match = text?.match(/```mermaid\n([\s\S]*?)\n```/);
  return match?.[1] ?? null;
}

let lastAppliedTheme: string | undefined;

function handleHostContextChanged(ctx: McpUiHostContext) {
  // The host can fire this notification many times in a burst for reasons
  // that have nothing to do with theme (e.g. container size settling right
  // after mount) — ctx.theme is present on every one of them, not just
  // actual theme flips. Re-rendering unconditionally on each one re-fits
  // the diagram, which changes the widget's height, which the host can
  // treat as a further context change, and around it goes: a growth loop
  // through this path instead of the ResizeObserver one fixed earlier.
  // Only re-render when the theme actually changed.
  if (ctx.theme && ctx.theme !== lastAppliedTheme) {
    lastAppliedTheme = ctx.theme;
    applyDocumentTheme(ctx.theme);
    initMermaid(ctx.theme);
    if (lastCode) void renderMermaid(lastCode);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
  updateFullscreenButton(ctx);
}

// Fall back to the OS/browser color scheme until the host tells us otherwise.
const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
initMermaid(prefersDark ? "dark" : "light");

const app = new App({ name: "Mermaid Viewer", version: "1.0.0" });

// Register handlers before connect() so we don't miss the initial tool result.
app.ontoolinput = () => {
  showStatus("Rendering diagram…");
};

app.ontoolresult = (result) => {
  const code = extractCode(result);
  if (code) {
    void renderMermaid(code);
  } else {
    showError("No Mermaid source was provided in the tool result.", "");
  }
};

app.onhostcontextchanged = handleHostContextChanged;

app.onerror = (err) => {
  console.error("MCP App error:", err);
};

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) handleHostContextChanged(ctx);
});
