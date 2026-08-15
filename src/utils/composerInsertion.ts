import type { MessageTextEntity, User } from "../telegram/types";

export interface ComposerTextInsertion {
  id: string;
  text: string;
  draftKey: string;
  userId?: string;
}

export interface ComposerInlineQuery {
  username: string;
  query: string;
}

export interface ComposerInsertionResult {
  value: string;
  cursor: number;
}

export interface ComposerMentionInsertionResult extends ComposerInsertionResult {
  entity: MessageTextEntity;
}

export const mentionTextForUser = (
  user: Pick<User, "displayName" | "username">,
) => `@${user.displayName.trim()}`;

export const insertComposerText = (
  value: string,
  text: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): ComposerInsertionResult => {
  const start = Math.max(0, Math.min(value.length, selectionStart));
  const end = Math.max(start, Math.min(value.length, selectionEnd));
  const prefix = value.slice(0, start);
  const suffix = value.slice(end);
  const leadingSpace = prefix && !/\s$/.test(prefix) && !/^\s/.test(text) ? " " : "";
  const trailingSpace = !/\s$/.test(text) && (!suffix || !/^\s/.test(suffix)) ? " " : "";
  const inserted = `${leadingSpace}${text}${trailingSpace}`;
  return {
    value: `${prefix}${inserted}${suffix}`,
    cursor: prefix.length + inserted.length,
  };
};

export const insertComposerMention = (
  value: string,
  text: string,
  userId: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): ComposerMentionInsertionResult => {
  const start = Math.max(0, Math.min(value.length, selectionStart));
  const end = Math.max(start, Math.min(value.length, selectionEnd));
  const prefix = value.slice(0, start);
  const leadingSpace = prefix && !/\s$/.test(prefix) && !/^\s/.test(text) ? " " : "";
  const result = insertComposerText(value, text, start, end);
  return {
    ...result,
    entity: {
      offset: prefix.length + leadingSpace.length,
      length: text.length,
      kind: "mentionName",
      userId,
    },
  };
};

export const composerInlineQueryForDraft = (
  value: string,
  knownNonBotUsernames?: ReadonlySet<string>,
): ComposerInlineQuery | undefined => {
  const match = value.match(/^@([A-Za-z0-9_]{5,32})\s+(.{0,256})$/);
  if (!match) return undefined;
  const username = match[1];
  if (knownNonBotUsernames?.has(username.toLocaleLowerCase())) return undefined;
  return { username, query: match[2] };
};
