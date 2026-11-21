import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // PLAN.md 1e: retries back off for real in production; tests run mocked failures without sleeping.
    env: { YAHOO_RETRY_BASE_MS: "0" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
