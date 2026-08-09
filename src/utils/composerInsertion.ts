import type { User } from "../telegram/types";

export interface ComposerTextInsertion {
  id: string;
  text: string;
}

export interface ComposerInsertionResult {
  value: string;
  cursor: number;
}

export const mentionTextForUser = (
  user: Pick<User, "displayName" | "username">,
) => {
  const username = user.username?.trim().replace(/^@/, "");
  return username ? `@${username}` : `@${user.displayName.trim()}`;
};

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
