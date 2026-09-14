import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { telegramStore } from "../store/telegramStore";
import { connectionPresentation } from "../telegram/connectionState";
import { openTelegramLinkInApp } from "../utils/externalLinks";
import { TelegramLinkInbox } from "./telegramLinkInbox";

const inbox = new TelegramLinkInbox(() => invoke<string[]>("notgram_take_telegram_links"));

export function installTelegramLinkReceiver() {
  if (!isTauri()) return () => undefined;
  let stopped = false;
  let detach: (() => void) | undefined;
  let unlisten: (() => void) | undefined;
  const unsubscribe = telegramStore.subscribe((state, previous) => {
    if (state.authorization.kind !== previous.authorization.kind || state.connectionStatus !== previous.connectionStatus || state.activeAccountId !== previous.activeAccountId || state.accountPending !== previous.accountPending) void inbox.wake();
  });
  void listen("notgram:pending-telegram-links", () => { void inbox.wake(); }).then(stop => {
    if (stopped) { stop(); return; }
    unlisten = stop;
    detach = inbox.attach({
      ready: () => {
        const state = telegramStore.getState();
        return !stopped && !state.accountPending && state.authorization.kind === "ready" && connectionPresentation(state.connectionStatus).operational;
      },
      open: openTelegramLinkInApp,
      error: error => telegramStore.setState({ operationError: String(error) }),
    });
  }).catch(error => { if (!stopped) telegramStore.setState({ operationError: String(error) }); });
  return () => { stopped = true; detach?.(); unlisten?.(); unsubscribe(); };
}
