import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: ".local/test-results/playwright",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build:client && npx vite preview --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: true,
  },
});
