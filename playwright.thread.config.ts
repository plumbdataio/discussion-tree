import { defineConfig, devices } from "@playwright/test";

// Config for the browser tests that spawn their own isolated broker:
// tests/thread-scroll.playwright.ts and tests/image-upload.playwright.ts.
// Separate from playwright.config.ts because that one boots a shared broker through
// `webServer` (fixed port, no temp DISCUSSION_TREE_HOME); these tests
// spawn their own fully isolated broker instead, so no webServer here.
export default defineConfig({
  testDir: "./tests",
  testMatch: /(thread-scroll|image-upload)\.playwright\.ts/,
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
