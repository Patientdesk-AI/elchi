import { test, expect } from "@playwright/test";

const fixture = "/tests/fixtures/notes-header/index.html";

test.describe("Meeting notes header", () => {
  test("the ⋯ menu keeps keyboard focus", async ({ page }) => {
    await page.goto(fixture);
    const more = page.getByRole("button", { name: "More actions" });

    // Opened from the keyboard, focus moves to the first item.
    await more.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: /Show transcript/ }),
    ).toBeFocused();

    // Arrow keys move between items and wrap.
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitem", { name: /Show transcript/ }),
    ).toBeFocused();

    // Escape closes it and hands focus back to "⋯", not to <body>.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
  });

  test("delete asks in place and keeps focus on the item", async ({ page }) => {
    await page.goto(fixture);
    await page.getByRole("button", { name: "More actions" }).click();
    const remove = page.getByRole("menuitem", { name: "Delete" });
    await remove.focus();
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("menuitem", { name: /Sure\?/ });
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.deleted)).toBe(true);
  });

  test("a shared meeting warns that deleting stops sharing, even with Share hidden", async ({
    page,
  }) => {
    await page.goto(`${fixture}?shared&noShare`);
    await expect(page.getByRole("button", { name: /Share/ })).toHaveCount(0);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(
      page.getByRole("menuitem", { name: /Delete and stop sharing\?/ }),
    ).toBeVisible();
  });
});
