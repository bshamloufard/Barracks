import { defineConfig } from "vitest/config";

/**
 * These tests start real processes, which takes far longer than a unit test,
 * so they get longer limits than Vitest's defaults.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
