import type { MessageDateTimeFormatting, MessageTextEntity } from "./types";
import type { TdObject } from "./tdlibMapper";

const dateTimePartPrecisionObject = (
  precision: MessageDateTimeFormatting["timePrecision"],
) => {
  switch (precision) {
    case "none": return { "@type": "dateTimePartPrecisionNone" };
    case "short": return { "@type": "dateTimePartPrecisionShort" };
    case "long": return { "@type": "dateTimePartPrecisionLong" };
    default: return { "@type": "dateTimePartPrecisionNone" };
  }
};

const dateTimeFormattingObject = (dateTime: MessageDateTimeFormatting) => {
  switch (dateTime.mode) {
    case "relative": return { "@type": "dateTimeFormattingTypeRelative" };
    case "absolute": return {
      "@type": "dateTimeFormattingTypeAbsolute",
      time_precision: dateTimePartPrecisionObject(dateTime.timePrecision),
      date_precision: dateTimePartPrecisionObject(dateTime.datePrecision),
      show_day_of_week: dateTime.showDayOfWeek === true,
    };
    case "original": return null;
  }
};

export const inputTextEntityType = (entity: MessageTextEntity): TdObject | undefined => {
  switch (entity.kind) {
    case "mentionName": return entity.userId && Number.isSafeInteger(Number(entity.userId)) && Number(entity.userId) > 0
      ? { "@type": "textEntityTypeMentionName", user_id: Number(entity.userId) } : undefined;
    case "textUrl": return entity.href ? { "@type": "textEntityTypeTextUrl", url: entity.href } : undefined;
    case "customEmoji": return entity.customEmojiId
      ? { "@type": "textEntityTypeCustomEmoji", custom_emoji_id: entity.customEmojiId } : undefined;
    case "dateTime": return entity.dateTime ? {
      "@type": "textEntityTypeDateTime", unix_time: entity.dateTime.unixTime,
      formatting_type: dateTimeFormattingObject(entity.dateTime),
    } : undefined;
    case "pre": return entity.language
      ? { "@type": "textEntityTypePreCode", language: entity.language } : { "@type": "textEntityTypePre" };
    case "phone": return { "@type": "textEntityTypePhoneNumber" };
    case "blockquote": return { "@type": "textEntityTypeBlockQuote" };
    default: return { "@type": "textEntityType" + entity.kind[0]!.toUpperCase() + entity.kind.slice(1) };
  }
};
