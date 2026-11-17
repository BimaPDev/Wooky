import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/*.browser.test.tsx"],
    environment: "node",
    testTimeout: 15_000,
  },
});
