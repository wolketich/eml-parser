import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["tests/e2e/**", "node_modules/**", "artifacts/**"],
    coverage: {
      reporter: ["text", "html"],
      include: ["apps/full-stack/src/server/**/*.ts"],
    },
  },
});
