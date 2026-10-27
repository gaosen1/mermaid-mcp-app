import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseContentType, sourceExtension, type ContentType } from "./src/content-type.js";

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** One persisted render_mermaid call. */
export interface Render {
  id: string;
  type: ContentType;
  source: string;
  /** Missing on renders made before titles existed. */
  title: string | null;
  /** Working directory of the session that made it; missing on renders from before workspaces were tracked. */
  workspace: string | null;
  createdAt: string;
}

interface Sidecar {
  title?: unknown;
  type?: unknown;
  workspace?: unknown;
  createdAt?: unknown;
}

/**
 * Renders on disk: `<id>.mmd` / `<id>.md` holds the source and `<id>.json` the
 * metadata beside it. Kept apart from the MCP layer so the format — including
 * the older shapes still lying around (no `type`, or no sidecar at all) — is
 * testable against a temp directory.
 */
export function createRenderStore(dir: string) {
  const sourcePath = (id: string, type: ContentType) => path.join(dir, `${id}.${sourceExtension(type)}`);
  const sidecarPath = (id: string) => path.join(dir, `${id}.json`);

  return {
    async save(input: { type: ContentType; source: string; title: string; workspace: string }): Promise<Render> {
      await fs.mkdir(dir, { recursive: true });
      const render: Render = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...input };
      const sidecar = { title: render.title, type: render.type, workspace: render.workspace, createdAt: render.createdAt };
      await Promise.all([
        fs.writeFile(sourcePath(render.id, render.type), render.source, "utf-8"),
        fs.writeFile(sidecarPath(render.id), JSON.stringify(sidecar, null, 2), "utf-8"),
      ]);
      return render;
    },

    /** null when the source is gone (e.g. pruned) — the sidecar alone isn't a render. */
    async load(id: string): Promise<Render | null> {
      const sidecar = await fs
        .readFile(sidecarPath(id), "utf-8")
        .then((raw) => JSON.parse(raw) as Sidecar)
        .catch(() => null);
      const type = parseContentType(sidecar?.type);
      const source = await fs.readFile(sourcePath(id, type), "utf-8").catch(() => null);
      if (source === null) return null;
      return {
        id,
        type,
        source,
        title: typeof sidecar?.title === "string" && sidecar.title ? sidecar.title : null,
        workspace: typeof sidecar?.workspace === "string" && sidecar.workspace ? sidecar.workspace : null,
        createdAt: typeof sidecar?.createdAt === "string" ? sidecar.createdAt : "",
      };
    },

    /** Best-effort cleanup so the directory doesn't grow forever. Never throws. */
    async prune(now = Date.now()): Promise<void> {
      try {
        const entries = await fs.readdir(dir);
        await Promise.all(
          entries.map(async (entry) => {
            const file = path.join(dir, entry);
            const stat = await fs.stat(file).catch(() => null);
            if (stat && now - stat.mtimeMs > MAX_AGE_MS) await fs.unlink(file).catch(() => {});
          }),
        );
      } catch {
        // Directory listing failed; not worth failing a tool call over.
      }
    },
  };
}

export type RenderStore = ReturnType<typeof createRenderStore>;
