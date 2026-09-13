import { expect, test } from "@playwright/test";

test("language setting switches the whole interface and persists", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveAttribute("data-language-preference", "system");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /高级设置/ }).click();

  const languageSection = page.locator(".settings-section", { has: page.getByRole("heading", { name: "界面语言" }) });
  await expect(languageSection.locator(".lucide-languages")).toBeVisible();
  const language = page.getByRole("combobox", { name: "界面语言" });
  await expect(language).toHaveValue("system");
  await expect(language.locator("option")).toHaveText([
    "跟随系统",
    "简体中文",
    "English",
    "日本語",
  ]);

  await language.selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("data-language-preference", "en");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Advanced Settings/ })).toBeVisible();

  await page.getByRole("combobox", { name: "Language" }).selectOption("ja");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("dialog", { name: "設定" })).toBeVisible();
  await expect(page.getByRole("button", { name: /詳細設定/ })).toBeVisible();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.locator("html")).toHaveAttribute("data-language-preference", "ja");
  await expect(page.getByRole("button", { name: "設定", exact: true })).toBeVisible();
});
