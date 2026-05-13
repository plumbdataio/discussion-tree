import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const TEST_PORT = 7891;
const TEST_DB = path.resolve("tests/test.db");

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${TEST_PORT}`,
    // Animations make screenshots flaky — disable them.
    launchOptions: {
      args: ["--disable-blink-features=AnimationPolicy"],
    },
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "bun tests/seed.ts && bun broker.ts",
    url: `http://127.0.0.1:${TEST_PORT}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      PARALLEL_DISCUSSION_PORT: String(TEST_PORT),
      PARALLEL_DISCUSSION_DB: TEST_DB,
    },
  },
  expect: {
    toHaveScreenshot: {
      // Allow ~0.5% pixel difference to absorb font rendering noise.
      maxDiffPixelRatio: 0.005,
      animations: "disabled",
    },
  },
});
