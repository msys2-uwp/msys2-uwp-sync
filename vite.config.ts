import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/minimal-safe-editing-check/cli.ts"),
      formats: ["es"],
      fileName: "cli",
    },
    outDir: "dist/minimal-safe-editing-check",
    emptyOutDir: true,
    rollupOptions: {
      external: ["node:fs", "node:path", "node:child_process", "node:process", "chardet"],
      output: {
        banner: "#!/usr/bin/env node",
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/minimal-safe-editing-check/**/*.test.ts", "tests/sync/**/*.test.ts"],
  },
});
