import { afterEach, describe, expect, it } from "vitest";
import { applyLanguagePreference } from "../i18n";
import { reportReasonLabel } from "../telegram/reportLabels";

describe("reportReasonLabel", () => {
  afterEach(() => applyLanguagePreference("zh-CN"));
  it.each([
    ["Spam and Scams", "垃圾信息或诈骗"],
    ["Violence", "暴力或危险内容"],
    ["Pornography", "色情或成人内容"],
    ["Child Abuse", "虐待儿童"],
    ["Copyright", "侵犯知识产权"],
    ["Unrelated Location", "与标注地点无关"],
    ["Fake", "虚假账号或冒充他人"],
    ["Fake Account", "虚假账号或冒充他人"],
    ["Illegal Drugs", "毒品或违禁药物"],
    ["Personal Details", "泄露个人信息"],
    ["Other", "其他原因"],
  ])("translates %s", (source, expected) => {
    expect(reportReasonLabel(source)).toBe(expected);
  });

  it("keeps an unknown server option distinct instead of duplicating Other", () => {
    expect(reportReasonLabel("A newly introduced server reason")).toBe("A newly introduced server reason");
    expect(reportReasonLabel("已本地化原因")).toBe("已本地化原因");
  });

  it.each([
    ["I don't like it", "我不喜欢此内容", "I don't like it", "この内容が気に入らない"],
    ["Illegal goods and services", "非法商品与服务", "Illegal goods and services", "違法な商品・サービス"],
    ["Personal data", "泄露个人信息", "Disclosure of Personal Information", "個人情報の漏洩"],
    ["It's not illegal, but it must be taken down", "内容并不违法，但应当下架", "It's not illegal, but it must be taken down", "違法ではないが削除すべき内容"],
  ])("localizes screenshot category %s in all interface languages", (source, zh, en, ja) => {
    for (const [language, expected] of [["zh-CN", zh], ["en", en], ["ja", ja]] as const) {
      applyLanguagePreference(language);
      expect(reportReasonLabel(source)).toBe(expected);
    }
  });

  it("does not collapse child sexual abuse or counterfeit goods into broader categories", () => {
    expect(reportReasonLabel("Child sexual abuse")).toBe("儿童性虐待");
    expect(reportReasonLabel("Child physical abuse")).toBe("对儿童的身体虐待");
    expect(reportReasonLabel("Counterfeit goods")).toBe("假冒商品");
    expect(reportReasonLabel("Spam")).not.toBe(reportReasonLabel("Scam"));
    expect(reportReasonLabel("Other copyrighted material")).toBe("Other copyrighted material");
    expect(reportReasonLabel(" I don’t like it ")).toBe("我不喜欢此内容");
  });

  it("translates known already-localized server labels when the interface language changes", () => {
    applyLanguagePreference("en");
    expect(reportReasonLabel("儿童性虐待")).toBe("Child sexual abuse");
    expect(reportReasonLabel("児童への性的虐待")).toBe("Child sexual abuse");
    applyLanguagePreference("ja");
    expect(reportReasonLabel("选择举报原因")).not.toBe("选择举报原因");
  });
});
