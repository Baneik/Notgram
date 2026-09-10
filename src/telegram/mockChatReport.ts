import { translate } from "../i18n";
import { validateChatReport } from "./chatReport";
import type { ChatReportResult, ReportChatInput } from "./types";

// Deterministic protocol fixtures, not a client-side taxonomy for real accounts.
const root = [
  ["dislike", "I don't like it"], ["child", "Child abuse"],
  ["violence", "Violence"], ["goods", "Illegal goods and services"],
  ["adult", "Pornography"], ["personal", "Personal data"],
  ["spam", "Spam or scam"], ["copyright", "Copyright infringement"],
  ["other", "Other"], ["takedown", "It's not illegal, but it must be taken down"],
];
const branches: Record<string, string[][]> = {
  spam: [["spam.spam", "Spam"], ["spam.scam", "Scam"], ["spam.fake", "Fake account"]],
  "spam.scam": [["spam.scam.phishing", "Phishing"], ["spam.scam.other", "Other"]],
  child: [["child.sexual", "Child sexual abuse"], ["child.physical", "Child physical abuse"], ["child.other", "Other"]],
  violence: [["violence.graphic", "Graphic violence"], ["violence.threats", "Threats of violence"], ["violence.terror", "Terrorism"], ["violence.other", "Other"]],
  goods: [["goods.drugs", "Illegal drugs"], ["goods.weapons", "Weapons"], ["goods.other", "Other"]],
  adult: [["adult.sexual", "Sexual content"], ["adult.intimate", "Non-consensual intimate images"], ["adult.other", "Other"]],
  personal: [["personal.doxxing", "Doxxing"], ["personal.documents", "Identity documents"], ["personal.other", "Other"]],
  copyright: [["copyright.piracy", "Piracy"], ["copyright.trademark", "Trademark infringement"], ["copyright.other", "Other"]],
};
const all = [...root, ...Object.values(branches).flat()];
const idFor = (key: string) => btoa(key);

export function mockChatReport(input: ReportChatInput): ChatReportResult {
  validateChatReport(input);
  if (!input.optionId) {
    return { kind: "options", title: "Report reason", options: root.map(([key, title]) => ({ id: idFor(key), title })) };
  }
  const selected = all.find(([key]) => idFor(key) === input.optionId || idFor(`comment:${key}`) === input.optionId);
  if (!selected) throw new Error(translate("举报原因无效"));
  const [key, title] = selected;
  const children = branches[key];
  if (children) return { kind: "options", title, options: children.map(([key, title]) => ({ id: idFor(key), title })) };
  if (input.messageIds.length === 0) return { kind: "messages" };
  const isOptional = key !== "other" && !key.endsWith(".other") && key !== "takedown";
  if (input.optionId !== idFor(`comment:${key}`) || (!isOptional && !input.text?.trim())) {
    return { kind: "text", optionId: idFor(`comment:${key}`), isOptional };
  }
  return { kind: "ok" };
}
