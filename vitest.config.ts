import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Shared CI runners (Windows especially) load modules and start browsers several times slower than a developer machine: three
    // different tests hit the 5 s default on different runs while passing in isolation. Only the CI default is raised; assertions are unchanged.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 60_000 : 10_000,
  },
});