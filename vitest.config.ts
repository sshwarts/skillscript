import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    setupFiles: ["./tests/setup.ts"],
  },
});
