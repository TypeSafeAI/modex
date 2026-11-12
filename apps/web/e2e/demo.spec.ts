import { expect, test, type Page } from "@playwright/test";

/** Every request the page makes, and anything the browser reported as wrong. */
async function watch(page: Page) {
  const requests: string[] = [];
  const problems: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  return { requests, problems };
}

test("the demo workspace opens, answers an approval and a follow-up, and stays on its own origin", async ({
  page,
  baseURL,
}) => {
  const { requests, problems } = await watch(page);
  await page.goto("/");
  await expect(page.getByTestId("web-banner")).toContainText(
    "Replies, files and approvals are simulated in this tab.",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await expect(
    page.getByText("Demo workspace: providers, files, approvals and replies are simulated"),
  ).toBeVisible();
  await expect(page.getByTestId("approval-question")).toContainText(
    "Apply the sample README change?",
  );

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("approval-answer")).toHaveText("Approved");
  await expect(
    page.getByText("Applied to the demo README in memory."),
  ).toBeVisible();

  await page.getByTestId("composer-input").fill("Summarize the change");
  await page.getByTestId("send").click();
  await expect(
    page.getByText("Demo reply to “Summarize the change”"),
  ).toBeVisible();

  expect(requests.length).toBeGreaterThan(0);
  for (const url of requests) expect(url.startsWith(baseURL!)).toBe(true);
  expect(problems).toEqual([]);
});

test("Reset demo starts a fresh workspace", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("approval-answer")).toHaveText("Approved");
  await expect(
    page.getByText("Applied to the demo README in memory."),
  ).toBeVisible();
  await page.getByTestId("web-reset").click();
  await expect(page.getByTestId("approval-question")).toBeVisible();
  await expect(
    page.getByText("Applied to the demo README in memory."),
  ).toBeHidden();
});

test("adding a project never asks for a folder on this computer", async ({
  page,
}) => {
  let dialogs = 0;
  page.on("dialog", (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });
  await page.goto("/");
  await expect(page.getByTestId("project-name")).toHaveText(["Modex demo"]);
  await page.getByTestId("add-project").click();
  await expect(page.getByTestId("project-name")).toHaveText([
    "Modex demo",
    "Another demo project",
  ]);
  expect(dialogs).toBe(0);
});

test("a phone gets the way to the site instead of a squeezed desktop interface", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("web-narrow")).toBeVisible();
  await expect(page.getByTestId("web-banner")).toBeHidden();
  await expect(page.locator(".web-workspace")).toBeHidden();
  await expect(
    page.getByRole("link", { name: "See how Modex works" }),
  ).toHaveAttribute("href", "https://modex.codes/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("web-narrow")).toBeHidden();
  await expect(page.getByTestId("approval-question")).toBeVisible();
});
