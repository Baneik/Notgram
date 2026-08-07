import { describe, expect, it } from "vitest";
import { reportReasonLabel } from "./SafetySettings";

describe("reportReasonLabel", () => {
  it.each([
    ["Spam and Scams", "垃圾信息或诈骗"],
    ["Violence", "暴力或危险内容"],
    ["Pornography", "色情或成人内容"],
    ["Child Abuse", "儿童伤害"],
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
});
