import { test, expect, type Page } from "@playwright/test";

const repo = "https://github.com/TypeSafeAI/modex";
const invite = "https://testflight.apple.com/join/Qr14JKCh";
function feed(version = "0.0.11") {
  return {
    release: {
      version,
      url: `${repo}/releases/tag/v${version}`,
      downloadUrl: `${repo}/releases/download/v${version}/Modex-${version}-arm64.dmg`,
    },
    stats: { stars: 1234, downloads: 5678, forks: 42 },
    checkedAt: "2026-10-05T20:00:00Z",
    stale: false,
  };
}
async function expectVersion(page: Page, version: string) {
  await expect(page.locator("[data-release-version]")).toHaveText([
    `v${version}`,
    `v${version}`,
  ]);
  for (const a of await page.locator("[data-mac-download]").all())
    await expect(a).toHaveAttribute("href", feed(version).release.downloadUrl);
  for (const a of await page.locator("[data-release-link]").all())
    await expect(a).toHaveAttribute("href", feed(version).release.url);
}

test("finds a new release while the page stays open, with accurate counts and public TestFlight actions", async ({
  page,
}) => {
  await page.clock.install();
  let latest = feed();
  let calls = 0;
  await page.route("**/api/release", (route) => {
    calls++;
    return route.fulfill({ json: latest });
  });
  await page.goto("/");
  await expectVersion(page, "0.0.11");
  await expect(
    page.getByRole("link", { name: "1,234 GitHub stars", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "5,678 Mac downloads", exact: true }),
  ).toContainText("5.7K");
  await expect(page.locator('[data-stat="downloads"]')).toHaveAttribute(
    "title",
    /not unique users/,
  );
  await expect(
    page.getByRole("link", { name: "42 GitHub forks", exact: true }),
  ).toBeVisible();
  await expect(page.locator(`a[href="${invite}"]`)).toHaveCount(2);
  await expect(page.locator("body")).not.toContainText("Coming soon");
  latest = feed("0.0.12");
  await page.clock.fastForward(5 * 60_000);
  await expectVersion(page, "0.0.12");
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) window.dispatchEvent(new Event("focus"));
  });
  expect(calls).toBe(2);
  // An older CDN response cannot roll back links already seen in this page.
  latest = feed("0.0.11");
  await page.clock.fastForward(5 * 60_000);
  await expect.poll(() => calls).toBe(3);
  await expectVersion(page, "0.0.12");
});

test("offline, partial and hostile responses keep all verified fallback links usable", async ({
  page,
}) => {
  let response: object | undefined;
  await page.route("**/api/release", (route) =>
    response ? route.fulfill({ json: response }) : route.abort(),
  );
  for (const candidate of [
    undefined,
    { release: { version: "0.0.11" } },
    {
      ...feed(),
      release: {
        ...feed().release,
        downloadUrl: "https://example.com/untrusted.dmg",
      },
      stats: { stars: "9999", downloads: -1 },
    },
  ]) {
    response = candidate;
    await page.goto("/");
    await expectVersion(page, "0.0.11");
    await expect(page.locator(".community-stats")).toBeHidden();
    await expect(
      page.getByRole("link", { name: "View TestFlight beta" }),
    ).toHaveAttribute("href", invite);
  }
});

test("cached counts are labeled and zero remains a real count", async ({
  page,
}) => {
  await page.route("**/api/release", (route) =>
    route.fulfill({
      json: {
        ...feed(),
        stats: { stars: 0, downloads: null, forks: 0 },
        stale: true,
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "0 GitHub stars", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-stat="downloads"]')).toBeHidden();
  await expect(page.locator("[data-stats-note]")).toHaveText(
    "Last available GitHub counts",
  );
});

test("the full product story remains readable and scrollable across desktop and mobile", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/release", (route) =>
    route.fulfill({ json: feed() }),
  );
  await page.goto("/");
  for (const [width, height] of [
    [320, 568],
    [375, 667],
    [390, 844],
    [768, 1024],
    [1024, 768],
    [1440, 900],
    [1920, 1080],
    [844, 390],
    [667, 375],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight),
    ).toBeGreaterThan(height);
    for (const selector of [
      ".hero-description",
      ".platform-note",
      "#workflow",
      "#advantages",
      "#get-started",
      "#iphone",
      ".faq",
    ]) {
      const content = page.locator(selector);
      await expect(content).toBeVisible();
      await content.scrollIntoViewIfNeeded();
      const box = (await content.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
    for (const selector of [
      ".hero-actions .button",
      ".hero-actions .text-link",
      '[data-scene-step="0"]',
      '[data-scene-step="1"]',
      '[data-scene-step="2"]',
      ".companion-copy .button",
      ".faq summary",
    ]) {
      for (const target of await page.locator(selector).all()) {
        expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
    }
    for (let step = 0; step < 3; step++) {
      await page.locator(`[data-scene-step="${step}"]`).click();
      await expect(page.locator(".showcase")).toHaveAttribute(
        "data-step",
        String(step),
      );
      await expect(page.locator("#desktop-screen")).toBeVisible();
      await expect
        .poll(() =>
          page
            .locator("#desktop-screen")
            .evaluate(
              (image: HTMLImageElement) =>
                image.complete && image.naturalWidth > 0,
            ),
        )
        .toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    }
    await page.locator("summary").filter({ hasText: "Is Modex free?" }).click();
    await expect(
      page.getByText("Modex does not include a model subscription.", {
        exact: false,
      }),
    ).toBeVisible();
    await page.locator("summary").filter({ hasText: "Is Modex free?" }).click();
  }
  // 200% text enlargement must reflow critical content without clipping it.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("body").evaluate((body) => {
    body.style.zoom = "2";
  });
  await expect(page.locator(".hero-description")).toBeVisible();
  await expect(page.locator(".platform-note")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    1280,
  );
});

test("workflow selection is deliberate and supports keyboard input without autoplay", async ({
  page,
}) => {
  await page.clock.install();
  await page.route("**/api/release", (route) =>
    route.fulfill({ json: feed() }),
  );
  await page.goto("/");
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion });
    await page.clock.runFor(16_000);
    await expect(page.locator(".showcase")).toHaveAttribute("data-step", "0");
  }
  const review = page.getByRole("button", { name: "02 Review the change" });
  await review.focus();
  await page.keyboard.press("Enter");
  await expect(review).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".scene-title")).toHaveText(
    "See what you’re approving.",
  );
  await expect(page.locator(".scene-copy")).toHaveAttribute(
    "aria-live",
    "polite",
  );
  await page.clock.runFor(16_000);
  await expect(page.locator(".showcase")).toHaveAttribute("data-step", "1");
  await page.keyboard.press("Tab");
  const result = page.getByRole("button", { name: "03 Approve & continue" });
  await expect(result).toBeFocused();
  await page.keyboard.press("Space");
  await expect(result).toHaveAttribute("aria-pressed", "true");
  await expect(review).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#desktop-screen")).toHaveAttribute(
    "src",
    "/assets/workflow-complete.png",
  );
  await expect(page.locator(".scene-title")).toHaveText(
    "Keep the change in view.",
  );
});

test("screenshots enlarge and close with Escape or the close button, restoring focus", async ({
  page,
}) => {
  await page.route("**/api/release", (route) =>
    route.fulfill({ json: feed() }),
  );
  await page.goto("/");
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const label of [
      "Enlarge the Modex approval screenshot",
      "Enlarge the workflow screenshot",
      "Enlarge the iPhone approval screenshot",
    ]) {
      const trigger = page.getByRole("link", { name: label, exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Close image" }),
      ).toBeFocused();
      await expect(page.locator("#expanded-image")).toHaveAttribute(
        "src",
        await trigger.evaluate((link: HTMLAnchorElement) => link.href),
      );
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Close image" }).click();
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    }
  }
});

test("downloads, setup, FAQ and original screenshots work without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(baseURL!);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://modex.codes/",
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://modex.codes/assets/social-preview.png",
  );
  await expectVersion(page, "0.0.11");
  await expect(
    page.getByRole("link", { name: "View TestFlight beta" }),
  ).toHaveAttribute("href", invite);
  await expect(page.locator(".step-buttons")).toBeHidden();
  await expect(page.locator(".hero-description")).toBeVisible();
  await expect(page.locator("#get-started")).toBeVisible();
  await page.locator("summary").filter({ hasText: "Is Modex free?" }).click();
  await expect(
    page.getByText("Modex does not include a model subscription.", {
      exact: false,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", {
      name: "Enlarge the Modex approval screenshot",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/assets\/workflow-approval\.png$/);
  await context.close();
});
