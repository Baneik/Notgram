import type { Message } from "../telegram/types";

export type MessageGroupPosition = "single" | "first" | "middle" | "last";

const localDay = (isoDate: string) => {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime())
    ? isoDate
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

const belongsToSameGroup = (left?: Message, right?: Message) => Boolean(
  left &&
  right &&
  left.senderId === right.senderId &&
  left.outgoing === right.outgoing &&
  localDay(left.sentAt) === localDay(right.sentAt),
);

export const groupConsecutiveMessages = (messages: Message[]): Message[][] =>
  messages.reduce<Message[][]>((groups, message) => {
    const current = groups.at(-1);
    if (current && belongsToSameGroup(current.at(-1), message)) {
      current.push(message);
    } else {
      groups.push([message]);
    }
    return groups;
  }, []);

export const messageGroupPosition = (
  messages: Message[],
  index: number,
): MessageGroupPosition => {
  const message = messages[index];
  if (!message) return "single";
  const joinsPrevious = belongsToSameGroup(messages[index - 1], message);
  const joinsNext = belongsToSameGroup(message, messages[index + 1]);
  if (!joinsPrevious && !joinsNext) return "single";
  if (!joinsPrevious) return "first";
  return joinsNext ? "middle" : "last";
};

export const isGroupFirst = (position: MessageGroupPosition) =>
  position === "single" || position === "first";

export const isGroupLast = (position: MessageGroupPosition) =>
  position === "single" || position === "last";
