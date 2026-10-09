import { defineConfig, devices } from "@playwright/test";

// Config for tests/thread-scroll.playwright.ts. Separate from
// playwright.config.ts because that one boots a shared broker through
// `webServer` (fixed port, no temp DISCUSSION_TREE_HOME); the thread test
// spawns its own fully isolated broker instead, so no webServer here.
export default defineConfig({
  testDir: "./tests",
  testMatch: /thread-scroll\.playwright\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
