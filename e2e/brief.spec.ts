import { expect, test } from "@playwright/test";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("search, period, brief, share link, and watchlist", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Tokens you save from a brief appear here.")).toBeVisible();
  await page.getByLabel("Contract address").fill(CA);
  await page.getByRole("group", { name: "Window" }).getByText("6h", { exact: true }).click();
  await page.getByRole("button", { name: "Look up" }).click();

  await expect(page.getByRole("heading", { name: "Fixture Coin" })).toBeVisible();
  await expect(page.getByText("Summary window: 6 hours.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What changed" })).toBeVisible();
  await expect(page.getByText(/3 points for the last 6 hours|4 points for the last 6 hours|5 points for the last 6 hours/)).toBeVisible();
  await expect(page.getByText("$1.25").first()).toBeVisible();
  await page.getByRole("button", { name: "Market cap" }).click();
  await expect(page.getByText("$2.5M").first()).toBeVisible();
  await page.getByRole("button", { name: "Price in dollars" }).click();
  await expect(page.getByText("$1.25").first()).toBeVisible();

  await page.getByRole("group", { name: "Window" }).getByText("1h", { exact: true }).click();
  await expect(page).toHaveURL(/period=1h/);
  await expect(page.getByText("Summary window: 1 hour.")).toBeVisible();
  await expect(page.getByText(/3 points for the last 1 hour|4 points for the last 1 hour|5 points for the last 1 hour/)).toBeVisible();

  await page.getByRole("button", { name: "Add to watchlist" }).click();
  await expect(page.getByRole("button", { name: "Remove from watchlist" })).toBeVisible();
  await expect(page.getByText("1 of 20 saved in this browser.")).toBeVisible();

  await page.getByRole("button", { name: "Open public page" }).click();
  await expect(page).toHaveURL(/\/brief\/[0-9a-f-]{36}$/i);
  await expect(
    page.getByText("This page does not change when the market moves."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fixture Coin" })).toBeVisible();
  await expect(page.getByText("Summary window: 1 hour.")).toBeVisible();

  await page.getByRole("link", { name: "Trench Brief" }).click();
  await expect(page.getByRole("heading", { name: "Watchlist" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Fixture Coin/ })).toBeVisible();
  await expect(page.getByText("1 of 20 saved in this browser.")).toBeVisible();
});
