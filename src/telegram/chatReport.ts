import { translate } from "../i18n";
import type { TdObject } from "./tdlibMapper";
import { numericId } from "./tdlibRequests";
import type { ChatReportResult, ReportChatInput } from "./types";

export const REPORT_TEXT_LIMIT = 1024;
export const REPORT_MESSAGE_LIMIT = 100;

export function validateChatReport(input: ReportChatInput) {
  if (Array.from(input.text ?? "").length > REPORT_TEXT_LIMIT) {
    throw new Error(translate("举报说明最多 {{count}} 个字符", { count: REPORT_TEXT_LIMIT }));
  }
  if (input.messageIds.length > REPORT_MESSAGE_LIMIT) {
    throw new Error(translate("单次最多举报 {{count}} 条消息", { count: REPORT_MESSAGE_LIMIT }));
  }
}

export function chatReportRequest(input: ReportChatInput): TdObject {
  validateChatReport(input);
  return {
    "@type": "reportChat",
    chat_id: numericId(input.chatId),
    // TDLib bytes are opaque base64 strings in JSON. Never decode or rewrite them.
    option_id: input.optionId,
    message_ids: input.messageIds.map(numericId),
    text: input.text ?? "",
  };
}

export function mapChatReportResult(raw: TdObject): ChatReportResult {
  switch (raw["@type"]) {
    case "reportChatResultOk": return { kind: "ok" };
    case "reportChatResultMessagesRequired": return { kind: "messages" };
    case "reportChatResultTextRequired":
      if (typeof raw.option_id === "string" && typeof raw.is_optional === "boolean") {
        return { kind: "text", optionId: raw.option_id, isOptional: raw.is_optional };
      }
      break;
    case "reportChatResultOptionRequired":
      if (typeof raw.title === "string" && Array.isArray(raw.options) && raw.options.length > 0) {
        const options = raw.options.flatMap((option: TdObject) => (
          option && typeof option.id === "string" && typeof option.text === "string"
            ? [{ id: option.id, title: option.text }] : []
        ));
        if (options.length === raw.options.length && new Set(options.map(option => option.id)).size === options.length) {
          return { kind: "options", title: raw.title, options };
        }
      }
  }
  throw new Error(translate("无法识别举报步骤，请重试"));
}
