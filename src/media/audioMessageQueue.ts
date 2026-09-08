import type { Message } from "../telegram/types";

export const audioMessageNeighbors = (messages: readonly Message[]) => {
  const audio = messages.filter(message => message.content.kind === "media" && ["audio", "voice"].includes(message.content.mediaType));
  const identity = (message?: Message) => message ? `${message.chatId}:${message.id}` : undefined;
  return new Map(audio.map((message, index) => [message.id, {
    previousId: identity(audio[index - 1]), nextId: identity(audio[index + 1]),
  }]));
};
