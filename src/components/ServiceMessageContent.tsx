import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { translate } from "../i18n";
import { presentServiceEvent } from "../telegram/serviceMessages";
import type { ServiceMessagePart } from "../telegram/serviceMessageTypes";
import type { Message } from "../telegram/types";
import { highlightedText } from "../utils/textHighlight";
import { localMediaSource } from "../media/localMediaSource";
import { StableImage } from "./StableImage";

export interface ServicePerson {
  id: string;
  name: string;
  profileAvailable: boolean;
}

export function ServiceMessageContent({ message, people = [], targetSummary, searchQuery,
  onOpenPerson, onOpenMessage }: {
  message: Message;
  people?: ServicePerson[];
  targetSummary?: string;
  searchQuery?: string;
  onOpenPerson: (id: string) => void;
  onOpenMessage: (chatId: string, messageId: string) => void;
}) {
  useTranslation();
  const [failedPhotos, setFailedPhotos] = useState<ReadonlySet<string>>(() => new Set());
  const { content } = message;
  if (content.kind !== "service" && content.kind !== "unsupported") return null;
  const event = content.kind === "service" ? content.event : undefined;
  const byId = new Map(people.map(person => [person.id, person]));
  const presentation = event ? presentServiceEvent(event, {
    personName: id => byId.get(id)?.name ?? translate("Telegram 用户"),
    targetSummary,
  }) : undefined;
  const legacyMembers = content.kind === "service" ? content.memberUserIds ?? [] : [];
  const parts: ServiceMessagePart[] = presentation?.parts ?? (legacyMembers.length
    ? legacyMembers.flatMap((id, index): ServiceMessagePart[] => [
        ...(index ? [{ kind: "text" as const, text: "、" }] : []),
        { kind: "person", id, text: byId.get(id)?.name ?? translate("Telegram 用户") },
      ]).concat({ kind: "text", text: translate(" 加入了群聊") })
    : [{ kind: "text", text: content.kind === "unsupported"
        ? translate("此消息暂不支持显示，请使用 Telegram 查看") : content.text }]);
  const renderParts = (parts: ServiceMessagePart[]) => parts.map((part, index) => {
    const label = highlightedText(part.text, searchQuery);
    if (part.kind === "person") return byId.get(part.id)?.profileAvailable ? (
      <button key={index} type="button" aria-label={translate("查看 {{value0}} 资料", { value0: part.text })}
        onClick={() => onOpenPerson(part.id)}><bdi><strong>{label}</strong></bdi></button>
    ) : <bdi key={index}><strong>{label}</strong></bdi>;
    if (part.kind === "message") return (
      <button key={index} type="button" onClick={() => onOpenMessage(part.chatId ?? message.chatId, part.messageId)}>
        {label}
      </button>
    );
    return <Fragment key={index}>{label}</Fragment>;
  });
  const preview = [event?.photo?.localPath ? localMediaSource(event.photo.localPath) : undefined,
    event?.photo?.previewDataUrl].find(source => source && !failedPhotos.has(source));
  const details = presentation?.details ?? [];
  const deletionDescription = message.isLocallyDeleted
    ? translate("这条消息已被删除，当前显示本地保留记录") : undefined;
  return <div className="message-service-content" title={deletionDescription} aria-description={deletionDescription}>
    <p>{renderParts(parts)}</p>
    {preview && <StableImage className="service-photo-preview" src={preview}
      alt={translate("聊天头像")} onError={() => setFailedPhotos(current => new Set([...current, preview]))} />}
    {details.length > 0 && <details className="service-message-details">
      <summary><span className="service-details-closed">{translate("查看详情")}</span><span className="service-details-open">{translate("收起详情")}</span></summary>
      {details.map((detail, index) => <p key={index}>{renderParts(detail)}</p>)}
    </details>}
  </div>;
}
