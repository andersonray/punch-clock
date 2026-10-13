import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// manifest.json is the single source of truth for the version.
const manifest = JSON.parse(
  readFileSync(new URL("../custom_components/punch_clock/manifest.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __PC_VERSION__: JSON.stringify(manifest.version),
  },
  build: {
    lib: {
      entry: "src/main.ts",
      formats: ["es"],
      fileName: () => "punch-clock-panel.js",
    },
    outDir: "../custom_components/punch_clock/frontend",
    emptyOutDir: true,
    target: "es2022",
    minify: true,
    reportCompressedSize: false,
  },
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
  },
});
