# Mermaid MCP App

An [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) server that gives Claude a `render_mermaid` tool: pass it raw Mermaid diagram source and it renders as an interactive SVG (pan/zoom, fit-to-width, copy source, fullscreen) directly inline in the conversation — instead of a static ` ```mermaid ` code block.

This is a standalone project. It owns all of its own dependencies (Mermaid, the MCP Apps SDK, etc.) and never touches any other project's `package.json` — it's meant to be a general-purpose tool available across every Claude Desktop conversation, not something wired into a specific codebase.

## How it's wired up

Claude Desktop launches this as a local (stdio) MCP server via `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mermaid": {
      "command": "node",
      "args": ["/absolute/path/to/mermaid-mcp-app/dist/main.js"]
    }
  }
}
```

This is a global entry (not scoped to any one project), so `render_mermaid` is available in every Claude Desktop conversation, on every restart, with no further action needed — **as long as `dist/` has already been built** (see below).

### Required: Developer Mode

Claude Desktop only renders the full custom widget (toolbar, pan/zoom, copy button) when **Developer Mode** is enabled. Without it, only a reduced fallback (diagram only, no controls) shows up.

Enable once: **Claude menu → Help → Troubleshooting → Enable Developer Mode**. This is a persistent app setting — it should not need to be re-enabled after a restart, but if the toolbar/controls ever disappear, check this first.

## Project layout

| File | Role |
|---|---|
| `server.ts` | MCP server: registers the `render_mermaid` tool and its `ui://mermaid/viewer-*` UI resource |
| `main.ts` | Process entry point — stdio transport by default (what Claude Desktop uses), `--http` for local testing |
| `mcp-app.html` | View shell (the UI resource's HTML) |
| `src/mcp-app.ts` | View logic: connects to the host, renders Mermaid client-side, pan/zoom/copy/fullscreen |
| `src/mcp-app.css` | View styling (light/dark, follows host theme) |
| `vite.config.ts` | Bundles the View (Mermaid included) into a single self-contained `dist/mcp-app.html` |

## First-time setup / rebuilding after a fresh checkout

```bash
pnpm install
pnpm run build
```

`dist/` is gitignored (it's a build artifact), so after cloning or `git clean` you must run `pnpm run build` before the `mermaid` entry in `claude_desktop_config.json` will work — it points directly at `dist/main.js`.

## Making changes

There's no hot reload. After editing `server.ts`, `main.ts`, or anything under `src/`:

```bash
pnpm run build
```

Then force Claude Desktop to pick up the change — it does **not** notice on its own, even after the resource URI changes, because it appears to cache MCP UI resources somewhat aggressively:

- **Reliable**: Developer menu → **Reload MCP Configuration** (this is what actually worked during development; simply killing the child process was not always sufficient)
- Then test in a **brand-new conversation** — an already-open one may keep reusing its first-mounted widget instance and never re-fetch, regardless of server-side changes.

The `ui://mermaid/viewer-<hash>.html` resource URI is derived from a content hash of `dist/mcp-app.html` (see `server.ts`), so every rebuild is, in principle, a new resource the host can't confuse with a stale one — but "Reload MCP Configuration" is still the step that's actually been confirmed to work reliably.

## Verifying changes without Claude Desktop

The official [`ext-apps`](https://github.com/modelcontextprotocol/ext-apps) repo ships a reference test host (`examples/basic-host`) that renders MCP Apps in a plain browser tab — much faster to iterate against than Claude Desktop itself:

```bash
# in this repo
pnpm exec tsx main.ts --http   # starts the server on :3901

# in a checkout of github.com/modelcontextprotocol/ext-apps
SERVERS='["http://localhost:3901/mcp"]' npx tsx examples/basic-host/serve.ts
# open http://localhost:8092 (sandbox iframe defaults to :8081, hardcoded by basic-host)
```

## Design notes

- **`securityLevel: "strict"`** in Mermaid's init config sanitizes diagram labels and disables click/script bindings — the diagram source is never executed as HTML/JS, even though it ultimately comes from the model.
- **Sizing**: the SVG is sized directly (explicit pixel `width`/`height` on the `<svg>`), scaled by container *width only* and never above its natural size. Mermaid's default output is already a readable size, so small diagrams aren't stretched to fill a wide panel, and tall ones keep legible text instead of being squashed. The viewing box is sized to the diagram so the whole thing shows at once with no scrolling (the host grows the iframe to follow); a 4000px cap is only a safety valve, past which the box falls back to native `overflow: auto` scrolling. Zoom is `⌘/Ctrl` + wheel or the toolbar buttons; drag-to-pan only activates once the diagram overflows the box (after zooming in), so at fit-size the mouse is left alone and node text stays selectable/copyable.
- **Why not CSS `transform: scale()` + `overflow: hidden`?** That was the first implementation, and it visibly failed to clip inside Claude Desktop (computed styles said `overflow: hidden` / 640px, yet the diagram painted well past the box). Real layout sizes + native scroll avoid depending on that combination.
- **Two resize/re-render feedback loops** had to be broken, both invisible in the ext-apps reference host and only reproducible in Claude Desktop: (1) a `ResizeObserver` on the viewport re-fitting on every resize, where the fit itself sets the viewport's height — now it only reacts to *width* changes, with a burst limit as a backstop; (2) re-rendering on every `host-context-changed` notification (the host sends many, all carrying `theme`) — now it only re-renders when the theme actually changes.
- **Debugging in Claude Desktop**: the widget lives in a nested cross-origin iframe, so DevTools' frame picker is painful. Temporarily rendering computed styles/rects into the widget itself (a small log box outside the diagram container) was far faster than DevTools.
- **Clipboard**: the sandboxed iframe blocks `navigator.clipboard` under Claude Desktop's permissions policy. The copy button falls back to `document.execCommand("copy")`, and if that also fails, to `window.prompt()` so there's always a way to get the source out manually.
