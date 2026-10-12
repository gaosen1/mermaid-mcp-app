import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, which insists on an INPUT html for the build.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
