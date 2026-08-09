import { invoke, isTauri } from "@tauri-apps/api/core";
import type { MouseEvent } from "react";
import { telegramStore } from "../store/telegramStore";
import {
  isUnsupportedTelegramLink,
  parseTelegramUrl,
} from "../telegram/telegramLinks";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:", "tg:"]);
const MAX_EXTERNAL_URL_LENGTH = 4_096;

export const safeExternalHref = (value?: string) => {
  if (!value || value.length > MAX_EXTERNAL_URL_LENGTH || value.trim() !== value) {
    return undefined;
  }
  if ([...value].some((character) => /[\u0000-\u001f\u007f]/.test(character))) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return ALLOWED_PROTOCOLS.has(parsed.protocol.toLowerCase()) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
};

export const openExternalLink = async (value: string) => {
  const href = safeExternalHref(value);
  if (!href) throw new Error("不支持此外链地址");
  if (await openTelegramLinkInApp(href)) return;
  if (isTauri()) {
    await invoke("notgram_open_external_url", { url: href });
    return;
  }
  const opened = globalThis.open(href, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
};

export const openTelegramLinkInApp = async (value: string) => {
  if (!parseTelegramUrl(value)) return false;
  const target = await telegramStore.getState().resolveTelegramLink(value);
  if (!target || isUnsupportedTelegramLink(target)) return true;
  globalThis.dispatchEvent(new CustomEvent("notgram:telegram-link-opened", { detail: target }));
  return true;
};

export const handleExternalLinkClick = (event: MouseEvent<HTMLAnchorElement>) => {
  event.preventDefault();
  event.stopPropagation();
  void openExternalLink(event.currentTarget.href);
};
