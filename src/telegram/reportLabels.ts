import { translate } from "../i18n";

// Exact aliases only: broad substring matching changes the meaning of subcategories.
// The server owns the tree and opaque IDs. Unknown labels must stay distinct.
const labels: Array<[string[], (language?: string) => string]> = [
  [["Choose a reason", "Select a reason", "Report reason", "Report Reason", "Report"], (language) => translate("选择举报原因", { lng: language })],
  [["Choose an option", "Select an option", "Choose a subcategory"], (language) => translate("选择具体原因", { lng: language })],
  [["I don't like it", "Don't like", "I do not like it"], (language) => translate("我不喜欢此内容", { lng: language })],
  [["Child abuse"], (language) => translate("虐待儿童", { lng: language })],
  [["Violence", "Violence and dangerous content"], (language) => translate("暴力或危险内容", { lng: language })],
  [["Illegal goods and services"], (language) => translate("非法商品与服务", { lng: language })],
  [["Pornography", "Pornography and sexual content", "Adult content"], (language) => translate("色情或成人内容", { lng: language })],
  [["Personal data", "Personal details", "Private information"], (language) => translate("泄露个人信息", { lng: language })],
  [["Spam or scam", "Spam and scams", "Spam and scam"], (language) => translate("垃圾信息或诈骗", { lng: language })],
  [["Copyright", "Copyright infringement", "Intellectual property", "Intellectual property infringement"], (language) => translate("侵犯知识产权", { lng: language })],
  [["Other", "Custom", "Something else"], (language) => translate("其他原因", { lng: language })],
  [["It's not illegal, but it must be taken down", "It is not illegal, but it must be taken down"], (language) => translate("内容并不违法，但应当下架", { lng: language })],
  [["Spam"], (language) => translate("垃圾信息", { lng: language })],
  [["Scam", "Scams", "Fraud"], (language) => translate("诈骗", { lng: language })],
  [["Phishing"], (language) => translate("网络钓鱼", { lng: language })],
  [["Fake", "Fake account", "Impersonation"], (language) => translate("虚假账号或冒充他人", { lng: language })],
  [["Unrelated location", "Unrelated to location"], (language) => translate("与标注地点无关", { lng: language })],
  [["Illegal drugs", "Drugs", "Drugs and illegal substances"], (language) => translate("毒品或违禁药物", { lng: language })],
  [["Weapons", "Weapons and explosives"], (language) => translate("武器与爆炸物", { lng: language })],
  [["Stolen goods"], (language) => translate("赃物", { lng: language })],
  [["Counterfeit goods"], (language) => translate("假冒商品", { lng: language })],
  [["Illegal services"], (language) => translate("非法服务", { lng: language })],
  [["Hate speech"], (language) => translate("仇恨言论", { lng: language })],
  [["Terrorism", "Terrorism and extremism"], (language) => translate("恐怖主义或极端主义", { lng: language })],
  [["Harassment", "Bullying", "Harassment and bullying"], (language) => translate("骚扰或霸凌", { lng: language })],
  [["Self-harm", "Self harm", "Suicide", "Self-harm or suicide"], (language) => translate("自残或自杀内容", { lng: language })],
  [["Graphic violence", "Gore"], (language) => translate("血腥暴力", { lng: language })],
  [["Threats", "Threats of violence"], (language) => translate("暴力威胁", { lng: language })],
  [["Animal abuse", "Animal cruelty"], (language) => translate("虐待动物", { lng: language })],
  [["Child sexual abuse", "Child sexual abuse material", "Sexual abuse of children"], (language) => translate("儿童性虐待", { lng: language })],
  [["Child exploitation", "Child sexual exploitation"], (language) => translate("剥削儿童", { lng: language })],
  [["Child trafficking"], (language) => translate("贩卖儿童", { lng: language })],
  [["Child physical abuse", "Physical abuse of children"], (language) => translate("对儿童的身体虐待", { lng: language })],
  [["Sexual content"], (language) => translate("色情内容", { lng: language })],
  [["Non-consensual intimate images", "Non-consensual sexual content", "Revenge porn"], (language) => translate("未经同意的私密影像", { lng: language })],
  [["Sexual violence"], (language) => translate("性暴力", { lng: language })],
  [["Doxxing", "Doxing"], (language) => translate("人肉搜索与隐私曝光", { lng: language })],
  [["Phone number", "Phone numbers"], (language) => translate("手机号码", { lng: language })],
  [["Address", "Home address"], (language) => translate("家庭住址", { lng: language })],
  [["Identity documents"], (language) => translate("身份证件", { lng: language })],
  [["Financial information"], (language) => translate("财务信息", { lng: language })],
  [["Trademark", "Trademark infringement"], (language) => translate("侵犯商标权", { lng: language })],
  [["Piracy", "Pirated content"], (language) => translate("盗版内容", { lng: language })],
  [["Defamation"], (language) => translate("诽谤", { lng: language })],
  [["Misinformation", "False information"], (language) => translate("虚假信息", { lng: language })],
];

const normalize = (text: string) => text.trim().replace(/[’‘]/g, "'").replace(/\s+/g, " ").toLowerCase();
const byAlias = new Map(labels.flatMap(([aliases, label]) => [...aliases, label("zh-CN"), label("en"), label("ja")].map(alias => [normalize(alias), label] as const)));

export function reportReasonLabel(title: string): string {
  const translated = byAlias.get(normalize(title));
  return translated ? translated() : title.trim() || translate("其他原因");
}
