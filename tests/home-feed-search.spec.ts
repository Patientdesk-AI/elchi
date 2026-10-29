import { test, expect, type Page } from "@playwright/test";

const fixture = "/tests/fixtures/home-feed/index.html";

const openSearch = async (page: Page) => {
  await page.getByRole("button", { name: "Search", exact: true }).click();
  return page.getByRole("searchbox", { name: "Search dictations…" });
};

const answer = (page: Page, query: string, cursor: number | null) =>
  expect
    .poll(() =>
      page.evaluate(([q, c]) => window.feed.answer(q, c), [
        query,
        cursor,
      ] as const),
    )
    .toBe(true);

test.describe("Home feed search", () => {
  test("a dictation edited to no longer match leaves the results", async ({
    page,
  }) => {
    await page.goto(fixture);
    await (await openSearch(page)).fill("zebra");
    await expect(page.getByText("1 result")).toBeVisible();

    await page.evaluate(() =>
      window.feed.emitHistory({
        action: "updated",
        entry: {
          id: 50,
          file_name: "50.wav",
          timestamp: 1_700_003_000,
          saved: false,
          title: "",
          transcription_text: "alpha note 50",
          post_processed_text: null,
          post_process_prompt: null,
          post_process_requested: false,
          app_name: null,
          edited_from: "alpha zebra note 50",
        },
      }),
    );
    await expect(page.getByText("No results")).toBeVisible();
  });

  test("the previous query's results can't be paged while the new one loads", async ({
    page,
  }) => {
    await page.goto(fixture);
    await page.evaluate(() => (window.feed.hold = true));
    const field = await openSearch(page);

    await field.fill("alpha");
    await answer(page, "alpha", null);
    await expect(page.getByText("50 results")).toBeVisible();

    // alpha's rows stay on screen until beta's first page arrives.
    await field.fill("beta");
    await expect(page.getByText("50 results")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Load older|Loading/ }),
    ).toHaveCount(0);

    await answer(page, "beta", null);
    await expect(page.getByText("33 results")).toBeVisible();
    await expect(page.locator("main")).not.toContainText("alpha note 20");
  });

  test("an older page of the previous query never joins the new results", async ({
    page,
  }) => {
    await page.goto(fixture);
    await page.evaluate(() => (window.feed.hold = true));
    const field = await openSearch(page);

    await field.fill("alpha");
    await answer(page, "alpha", null);
    await expect(page.getByText("50 results")).toBeVisible();

    // Ask for alpha's next page, then change the query before it arrives.
    await page.getByRole("button", { name: "Load older" }).click();
    await field.fill("beta");
    await answer(page, "beta", null);
    await expect(page.getByText("33 results")).toBeVisible();
    await answer(page, "alpha", 22);

    const main = page.locator("main");
    await expect(main).toContainText("beta note 99");
    // Even ids up to 20 come only from alpha's late page.
    await expect(main).not.toContainText("alpha note 20");
    await expect(page.getByText("33 results")).toBeVisible();
  });

  test("scrolling loads older dictations after a search is closed", async ({
    page,
  }) => {
    await page.goto(fixture);
    const main = page.locator("main");
    await expect(main).toContainText("note 61");

    await (await openSearch(page)).fill("alpha");
    await expect(page.getByText("50 results")).toBeVisible();
    await page.getByRole("button", { name: "Close search" }).click();
    await expect(main).toContainText("note 61");

    await main.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(main).toContainText("note 60");
  });
});
