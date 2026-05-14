import { expect, test } from "@playwright/test";

// Visual regression baselines. Run once with `--update-snapshots` to capture
// the baseline images; subsequent runs compare against them. Use to verify a
// refactor (e.g. component splitting) preserves rendering pixel-for-pixel.

test.describe("layout snapshots", () => {
  test("root dashboard", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("root.png", { fullPage: true });
  });

  test("session dashboard", async ({ page }) => {
    await page.goto("/session/s_test");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("session.png", { fullPage: true });
  });

  test("complex board", async ({ page }) => {
    await page.goto("/board/bd_complex");
    await page.waitForLoadState("networkidle");
    // Wait for the board to be fully rendered (concern card titles visible).
    await page.locator("text=API design review").first().waitFor();
    await expect(page).toHaveScreenshot("board-complex.png", { fullPage: true });
  });

  test("minimal board (single concern × single item)", async ({ page }) => {
    await page.goto("/board/bd_minimal");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("board-minimal.png", { fullPage: true });
  });
});
