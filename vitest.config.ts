import { defineConfig } from "vitest/config";

process.env.AGE_SKIP_SHELL_ENV ??= "1";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/*.browser.test.tsx"],
    environment: "node",
    testTimeout: 15_000,
  },
});
