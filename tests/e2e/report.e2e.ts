import { expect, test, type Locator, type Page } from "@playwright/test";
import type { TelegramState } from "../../src/store/telegramStore.types";
import type { ChatReportResult, ReportChatInput } from "../../src/telegram/types";

type ReportStore = { getState: () => TelegramState; setState: (state: Partial<TelegramState>) => void };
declare global {
  interface Window {
    reportTest: { requests: ReportChatInput[]; initialCalls: number; deletes: number; finish?: (result: ChatReportResult) => void };
  }
}

const openProfileReport = async (page: Page) => {
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  await page.getByRole("dialog", { name: "资料", exact: true }).getByRole("button", { name: "举报", exact: true }).click();
  return page.locator(".report-dialog");
};
const choose = async (report: Locator, reason: string) => {
  await report.getByRole("radio", { name: reason, exact: true }).check();
  await report.getByRole("button", { name: "继续举报", exact: true }).click();
};
const fixture = async (page: Page, options: { initial: ChatReportResult | "fail"; responses?: Array<ChatReportResult | "fail" | "wait">; deleteFails?: boolean }) => {
  await page.evaluate(async options => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as { telegramStore: ReportStore };
    const state = telegramStore.getState();
    window.reportTest = { requests: [], initialCalls: 0, deletes: 0 };
    const responses = [...(options.responses ?? [])];
    telegramStore.setState({
      getChatReportOptions: async () => {
        window.reportTest.initialCalls++;
        if (options.initial === "fail") {
          if (window.reportTest.initialCalls === 1) throw new Error("offline");
          return { kind: "options", title: "Report reason", options: [{ id: "AA==", title: "Other" }] };
        }
        return options.initial;
      },
      reportChat: async input => {
        window.reportTest.requests.push(input);
        const next = responses.shift();
        if (next === "fail" || !next) throw new Error("offline");
        if (next === "wait") return new Promise(resolve => { window.reportTest.finish = resolve; });
        return next;
      },
      leaveGroup: async (...args) => {
        window.reportTest.deletes++;
        if (options.deleteFails && window.reportTest.deletes === 1) return false;
        if (options.deleteFails) return true;
        return state.leaveGroup(...args);
      },
    });
  }, options);
};

test("reports through three category levels, message selection, optional comment and confirmation", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/");
  const report = await openProfileReport(page);
  await expect(report.getByRole("radio")).toHaveCount(10);
  await expect(report.getByRole("radio", { name: "我不喜欢此内容" })).toBeVisible();
  await expect(report.getByRole("radio", { name: "非法商品与服务" })).toBeVisible();
  await expect(report.getByRole("radio", { name: "泄露个人信息" })).toBeVisible();
  await expect(report.getByRole("radio", { name: "内容并不违法，但应当下架" })).toBeVisible();
  await expect(report.getByRole("button", { name: "继续举报" })).toBeDisabled();
  await choose(report, "垃圾信息或诈骗");
  await expect(report.getByRole("radio")).toHaveCount(3);
  await report.getByRole("button", { name: "返回上一级" }).click();
  await expect(report.getByRole("radio", { name: "垃圾信息或诈骗" })).toBeChecked();
  await report.getByRole("button", { name: "继续举报" }).click();
  await choose(report, "诈骗");
  await choose(report, "网络钓鱼");
  await expect(report.getByRole("heading", { name: "选择举报消息" })).toBeVisible();
  await expect(report.getByRole("button", { name: "继续举报" })).toBeDisabled();
  await report.locator(".report-message-row input").first().check();
  await report.getByRole("button", { name: "继续举报" }).click();
  await expect(report.getByText("补充说明（选填）")).toBeVisible();
  await report.getByRole("textbox", { name: "举报说明" }).fill("测试说明");
  await report.getByRole("button", { name: "提交举报" }).click();
  await expect(report.getByRole("heading", { name: "举报已提交" })).toBeVisible();
  await report.getByRole("button", { name: "完成" }).click();
  await expect(report).toBeHidden();
});

test("retries initial and submit failures, preserves drafts and uses the text response option ID", async ({ page }) => {
  await page.goto("/");
  await fixture(page, { initial: "fail", responses: [{ kind: "text", optionId: "AAE+/w==", isOptional: false }, "fail", { kind: "ok" }] });
  const report = await openProfileReport(page);
  await expect(report.getByRole("alert")).toHaveText("无法读取举报选项");
  await report.getByRole("button", { name: "重试", exact: true }).click();
  await choose(report, "其他原因");
  await expect(report.getByRole("button", { name: "提交举报" })).toBeDisabled();
  await report.getByRole("textbox", { name: "举报说明" }).fill("  ");
  await expect(report.getByRole("button", { name: "提交举报" })).toBeDisabled();
  const details = "中😀".repeat(512);
  await report.getByRole("textbox", { name: "举报说明" }).fill(details);
  await expect(report.getByText("1024 / 1024 个字符")).toBeVisible();
  await report.getByRole("button", { name: "提交举报" }).click();
  await expect(report.getByRole("alert")).toBeVisible();
  await expect(report.getByRole("textbox", { name: "举报说明" })).toHaveValue(details);
  await report.getByRole("button", { name: "提交举报" }).click();
  await expect(report.getByRole("heading", { name: "举报已提交" })).toBeVisible();
  const requests = await page.evaluate(() => window.reportTest.requests);
  expect(requests.slice(1)).toEqual(Array(2).fill({ chatId: "chat-product", messageIds: [], optionId: "AAE+/w==", text: details }));
});

test("preserves the option and comment when the server requests messages after text", async ({ page }) => {
  await page.goto("/");
  await fixture(page, { initial: { kind: "text", optionId: "BQA=", isOptional: true }, responses: [{ kind: "messages" }, { kind: "ok" }] });
  const report = await openProfileReport(page);
  await report.getByRole("textbox", { name: "举报说明" }).fill("保留说明");
  await report.getByRole("button", { name: "提交举报" }).click();
  await report.locator(".report-message-row input").first().check();
  await report.getByRole("button", { name: "继续举报" }).click();
  await expect(report.getByRole("heading", { name: "举报已提交" })).toBeVisible();
  const requests = await page.evaluate(() => window.reportTest.requests);
  expect(requests[1]).toMatchObject({ optionId: "BQA=", text: "保留说明" });
  expect(requests[1].messageIds).toHaveLength(1);
});

test("shows initial success and retries leaving a group without reporting twice", async ({ page }) => {
  await page.goto("/");
  await fixture(page, { initial: { kind: "ok" } });
  let report = await openProfileReport(page);
  await expect(report.getByRole("heading", { name: "举报已提交" })).toBeVisible();
  await report.getByRole("button", { name: "完成" }).click();
  await page.getByRole("button", { name: "关闭资料" }).click();
  await fixture(page, { initial: { kind: "text", optionId: "", isOptional: true }, responses: [{ kind: "ok" }], deleteFails: true });
  report = await openProfileReport(page);
  await report.getByRole("checkbox", { name: "举报成功后退出这个群组" }).check();
  await report.getByRole("button", { name: "提交举报" }).click();
  await expect(report.getByRole("alert")).toContainText("举报已提交，但退出群组失败");
  await report.getByRole("button", { name: "重试退出群组" }).click();
  await expect(report.getByText("已退出群组", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => [window.reportTest.requests.length, window.reportTest.deletes])).toEqual([1, 2]);
});

test("retains distinct server choices and localizes language changes without reloading the report", async ({ page }) => {
  await page.goto("/");
  await fixture(page, { initial: { kind: "options", title: "Choose a subcategory", options: [
    { id: "one", title: "Child sexual abuse" }, { id: "two", title: "Child physical abuse" },
    { id: "three", title: "Other" }, { id: "four", title: "Something else" }, { id: "five", title: "New server category" },
  ] } });
  const report = await openProfileReport(page);
  await expect(report.getByRole("radio")).toHaveCount(5);
  await report.getByRole("radio", { name: "儿童性虐待", exact: true }).check();
  for (const [language, label, heading] of [["en", "Child sexual abuse", "Select a specific reason"], ["ja", "児童への性的虐待", "具体的な理由を選択"]]) {
    await page.evaluate(async language => {
      const { applyLanguagePreference } = await (0, eval)('import("/src/i18n/index.ts")');
      applyLanguagePreference(language);
    }, language);
    await expect(report.getByRole("radio", { name: label, exact: true })).toBeChecked();
    await expect(report.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  await expect(report.getByRole("radio", { name: "New server category" })).toBeVisible();
  expect(await page.evaluate(() => window.reportTest.initialCalls)).toBe(1);
});

test("keeps keyboard focus in the report and Escape returns to the profile", async ({ page }) => {
  await page.goto("/");
  const report = await openProfileReport(page);
  await expect(report.getByRole("radio")).toHaveCount(10);
  await report.getByRole("button", { name: "关闭举报" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(report.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(report.getByRole("button", { name: "关闭举报" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(report).toBeHidden();
  await expect(page.getByRole("dialog", { name: "资料", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "资料", exact: true }).getByRole("button", { name: "举报", exact: true })).toBeFocused();
});

test("ignores a late success after closing and prevents duplicate submission while pending", async ({ page }) => {
  await page.goto("/");
  await fixture(page, { initial: { kind: "text", optionId: "AQ==", isOptional: true }, responses: ["wait"] });
  const report = await openProfileReport(page);
  await report.getByRole("checkbox", { name: "举报成功后退出这个群组" }).check();
  await report.getByRole("button", { name: "提交举报" }).click();
  await expect(report.getByRole("button", { name: "提交举报" })).toBeDisabled();
  await report.getByRole("button", { name: "关闭举报" }).click();
  await page.evaluate(() => window.reportTest.finish?.({ kind: "ok" }));
  await expect(report).toBeHidden();
  expect(await page.evaluate(() => [window.reportTest.requests.length, window.reportTest.deletes])).toEqual([1, 0]);
});

test("keeps root choices and comment submission usable in a narrow window", async ({ page }) => {
  await page.goto("/");
  const report = await openProfileReport(page);
  await page.setViewportSize({ width: 390, height: 640 });
  await expect(report.getByRole("radio")).toHaveCount(10);
  expect(await report.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await choose(report, "其他原因");
  await report.locator(".report-message-row input").first().check();
  await report.getByRole("button", { name: "继续举报" }).click();
  await report.getByRole("textbox", { name: "举报说明" }).fill("窄窗口说明");
  await expect(report.getByRole("button", { name: "提交举报" })).toBeInViewport();
  expect(await report.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
});

test("searches and pages report evidence independently, retaining selected messages across searches", async ({ page }) => {
  await page.goto("/");
  await fixture(page, { initial: { kind: "messages" }, responses: [{ kind: "ok" }] });
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as { telegramStore: ReportStore };
    const original = telegramStore.getState().messages.get("chat-product")![0];
    telegramStore.setState({ loadReportMessages: async input => {
      if (input.query === "other") return { messages: [{ ...original, id: "other-result", content: { kind: "text", text: "other evidence" } }], hasMore: false };
      if (!input.fromMessageId) return { messages: [], hasMore: true, nextFromMessageId: "older-page" };
      return { messages: [{ ...original, id: "older-result", content: { kind: "text", text: "older evidence" } }], hasMore: false };
    } });
  });
  const report = await openProfileReport(page);
  await expect(report.getByText("没有找到可举报的消息")).toBeVisible();
  await report.getByRole("button", { name: "加载更多" }).click();
  await report.getByRole("checkbox", { name: /older evidence/ }).check();
  await report.getByRole("searchbox", { name: "搜索举报消息" }).fill("other");
  await report.getByRole("button", { name: "搜索", exact: true }).click();
  await report.getByRole("checkbox", { name: /other evidence/ }).check();
  await expect(report.getByText("已选择 2 / 100 条消息")).toBeVisible();
  await report.getByRole("button", { name: "继续举报" }).click();
  await expect(report.getByRole("heading", { name: "举报已提交" })).toBeVisible();
  expect(await page.evaluate(() => window.reportTest.requests[0].messageIds)).toEqual(["older-result", "other-result"]);
});

test("restores the comment on back and clears stale account responses", async ({ page }) => {
  await page.goto("/");
  await fixture(page, { initial: { kind: "text", optionId: "AQ==", isOptional: false }, responses: [{ kind: "messages" }, "wait"] });
  const report = await openProfileReport(page);
  await report.getByRole("textbox", { name: "举报说明" }).fill("保存草稿");
  await report.getByRole("button", { name: "提交举报" }).click();
  await report.getByRole("button", { name: "返回上一级" }).click();
  await expect(report.getByRole("textbox", { name: "举报说明" })).toHaveValue("保存草稿");
  await report.getByRole("button", { name: "提交举报" }).click();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as { telegramStore: ReportStore };
    telegramStore.setState({ activeAccountId: "another-account" });
  });
  await expect(report).toBeHidden();
  await page.evaluate(() => window.reportTest.finish?.({ kind: "ok" }));
  await expect(report).toBeHidden();
  expect(await page.evaluate(() => window.reportTest.initialCalls)).toBe(1);
});
