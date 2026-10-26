import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { ReceiptView } from "../../src/types.js";

test("read-only API distinguishes wrong account types from a chain outage", async ({
  request,
}) => {
  const wrong = await request.get(
    "/api/receipts/11111111111111111111111111111111",
  );
  expect(wrong.status()).toBe(422);
  expect((await wrong.json()).error.code).toBe("INVALID_RECEIPT");
});

test("read actual on-chain receipts and export signed acknowledgment state", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#receipt-count")).toHaveText("3");
  await page.locator("#status-filter").selectOption("acknowledged");
  await expect(page.locator("#receipt-list button")).toHaveCount(1);
  await expect(page.locator("#receipt-detail")).toContainText(
    "Both parties signed",
  );
  await expect(page.locator(".timeline .complete")).toHaveCount(3);
  const pending = page.waitForEvent("download");
  await page.locator("#export-receipt").click();
  const download = await pending;
  const exported = JSON.parse(
    await readFile((await download.path())!, "utf8"),
  ) as { network: string; receipt: ReceiptView };
  expect(exported.network).toBe("localnet");
  expect(exported.receipt.status).toBe("acknowledged");
  expect(exported.receipt.requestHash).toMatch(/^[0-9a-f]{64}$/);
  expect(exported.receipt.responseHash).toMatch(/^[0-9a-f]{64}$/);
  expect(exported.receipt.createdAt).toBeLessThanOrEqual(
    exported.receipt.deliveredAt!,
  );
  expect(exported.receipt.deliveredAt).toBeLessThanOrEqual(
    exported.receipt.acknowledgedAt!,
  );
  await expect(page.locator(".page-footer")).toContainText(
    "not proof of delivery or correctness",
  );
});

test("filter pending claims, search by commitment and recover from empty results", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#receipt-count")).toHaveText("3");
  await page.locator("#status-filter").selectOption("created");
  await expect(page.locator(".timeline .complete")).toHaveCount(1);
  await expect(page.locator("#receipt-detail")).toContainText(
    "Waiting for the provider's signed claim",
  );
  await page.locator("#receipt-search").fill("no-such-receipt");
  await expect(page.locator("#receipt-detail")).toContainText(
    "No matching receipts",
  );
  await page.locator("#receipt-search").clear();
  await page.locator("#status-filter").selectOption("delivered");
  await expect(page.locator(".timeline .complete")).toHaveCount(2);
  await expect(page.locator("#receipt-detail")).toContainText(
    "Delivery claimed",
  );
});

test("a failed refresh labels previous chain data and can retry", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#receipt-count")).toHaveText("3");
  await page.route("**/api/receipts", (route) =>
    route.fulfill({
      status: 502,
      json: {
        error: {
          code: "CHAIN_UNAVAILABLE",
          message: "The local validator is unavailable.",
        },
      },
    }),
  );
  await page.locator("#refresh").click();
  await expect(page.locator("#error-banner")).toBeVisible();
  await expect(page.locator("#connection-state")).toContainText(
    /previous|stale|unavailable/i,
  );
  await page.unroute("**/api/receipts");
  await page.locator("#refresh").click();
  await expect(page.locator("#error-banner")).toBeHidden();
});

test("architecture and guide are available offline inside the app", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Architecture", exact: true }).click();
  await expect(page.locator(".guide-content img")).toBeVisible();
  expect(
    await page
      .locator(".guide-content img")
      .evaluate((image) => (image as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
  await page.getByRole("link", { name: "Back to receipts" }).click();
  await page.getByRole("link", { name: "Guide", exact: true }).click();
  await expect(page.locator("#sign-a-receipt")).toBeVisible();
});

test("keyboard filters work and layouts fit phone and tablet widths", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#receipt-count")).toHaveText("3");
  await page.locator("#status-filter").focus();
  await page.keyboard.press("c");
  await page.keyboard.press("Enter");
  await expect(page.locator("#status-filter")).toHaveValue("created");
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
