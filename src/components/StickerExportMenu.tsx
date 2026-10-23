import { Download, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useNativeContextMenu } from "../contextMenu/nativeContextMenuBridge";
import { translate } from "../i18n";
import { useTelegramStore } from "../store/telegramStore";
import type { StickerExportResult, StickerExportTarget } from "../telegram/types";
import { currentColorTheme } from "../theme/theme";
import { ContextMenuPanel, ContextMenuSurface, type ContextMenuPoint } from "./ContextMenuSurface";

interface MenuState {
  target: StickerExportTarget;
  point: ContextMenuPoint;
  anchor: HTMLElement;
  keyboardNavigation?: boolean;
}

function StickerExportMenu({ menu, pending, onExport, onClose }: {
  menu: MenuState;
  pending: boolean;
  onExport: (target: StickerExportTarget) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    // Escape also belongs to the menu before its deferred initial focus runs.
    const dismiss = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      globalThis.setTimeout(() => menu.anchor.focus({ preventScroll: true }), 0);
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [menu.anchor, onClose]);
  const label = menu.target.kind === "set" ? translate("导出贴纸包") : translate("导出贴纸");
  const select = () => { onClose(); onExport(menu.target); };
  const native = useNativeContextMenu({
    label,
    colorTheme: currentColorTheme(),
    keyboardNavigation: menu.keyboardNavigation,
    items: [{ id: "export", label, icon: "download", disabled: pending }],
  }, menu.point, select, onClose);
  if (native) return null;
  return (
    <ContextMenuSurface label={label} point={menu.point} keyboardNavigation={menu.keyboardNavigation}
      restoreFocus={() => menu.anchor.focus({ preventScroll: true })} onClose={onClose} className="sticker-export-menu">
      <ContextMenuPanel>
        <button type="button" role="menuitem" disabled={pending} onClick={select}>
          <Download size={17} /><span>{label}</span>
        </button>
      </ContextMenuPanel>
    </ContextMenuSurface>
  );
}

export function useStickerExport(scopeKey: string) {
  const exportStickers = useTelegramStore(state => state.exportStickers);
  const pending = useTelegramStore(state => state.stickerExportPending);
  const accountId = useTelegramStore(state => state.activeAccountId);
  const [menu, setMenu] = useState<MenuState>();
  const [result, setResult] = useState<StickerExportResult>();
  const session = useRef<object | undefined>(undefined);
  useEffect(() => {
    session.current = {};
    setMenu(undefined);
    setResult(undefined);
    return () => { session.current = undefined; };
  }, [accountId, scopeKey]);
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const startExport = async (target: StickerExportTarget) => {
    const owner = session.current;
    if (!owner || pending) return;
    setResult(undefined);
    const next = await exportStickers(target);
    if (session.current === owner) setResult(next);
  };
  const menuProps = (target: StickerExportTarget) => ({
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ target, point: { x: event.clientX, y: event.clientY }, anchor: event.currentTarget });
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu({ target, point: { x: rect.left, y: rect.bottom }, anchor: event.currentTarget, keyboardNavigation: true });
    },
  });
  return {
    pending, menuOpen: Boolean(menu), closeMenu, menuProps,
    exportTarget: (target: StickerExportTarget) => { void startExport(target); },
    menu: menu && <StickerExportMenu menu={menu} pending={pending} onExport={target => void startExport(target)} onClose={closeMenu} />,
    status: pending || result === "saved" || result === "failed" ? (
      <span className="sticker-export-status" role={result === "failed" && !pending ? "alert" : "status"}>
        {pending && <LoaderCircle className="spin" size={14} />}
        {pending ? translate("正在导出贴纸") : result === "saved" ? translate("贴纸已导出") : translate("导出贴纸失败")}
      </span>
    ) : undefined,
  };
}
