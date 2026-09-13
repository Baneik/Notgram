import { Bold, ChevronRight, ClipboardPaste, Copy, EyeOff, Link, Quote, Scissors, Strikethrough, Type, Underline } from "lucide-react";
import { useRef, useState } from "react";
import { translate } from "../i18n";
import { useNativeContextMenu, type NativeContextMenuIcon } from "../contextMenu/nativeContextMenuBridge";
import type { ComposerFormat } from "../utils/composerFormatting";
import { ContextMenuPanel, ContextMenuSurface, type ContextMenuPoint } from "./ContextMenuSurface";
import { handleMenuKeyboard } from "../utils/menuKeyboard";

export type ComposerMenuAction = ComposerFormat | "cut" | "copy" | "paste";

export function ComposerContextMenu({ point, selected, colorTheme, onAction, onClose, restoreFocus }: {
  point: ContextMenuPoint;
  selected: boolean;
  colorTheme: "light" | "dark";
  onAction: (action: ComposerMenuAction) => void;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const submenuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const clipboard = [
    { id: "cut" as const, label: translate("剪切"), Icon: Scissors },
    { id: "copy" as const, label: translate("复制"), Icon: Copy },
    { id: "paste" as const, label: translate("粘贴"), Icon: ClipboardPaste },
  ];
  const formats = [
    { id: "spoiler" as const, label: translate("遮罩"), Icon: EyeOff },
    { id: "strikethrough" as const, label: translate("删除线"), Icon: Strikethrough },
    { id: "underline" as const, label: translate("下划线"), Icon: Underline },
    { id: "bold" as const, label: translate("粗体"), Icon: Bold },
    { id: "blockquote" as const, label: translate("引用"), Icon: Quote },
    { id: "link" as const, label: translate("链接"), Icon: Link },
  ];
  const nativeMenu = useNativeContextMenu({
    label: translate("输入框操作"), colorTheme,
    items: [
      ...clipboard.map(item => ({ id: item.id, label: item.label, icon: item.id as NativeContextMenuIcon,
        disabled: item.id !== "paste" && !selected })),
      { id: "format", label: translate("格式"), icon: "format", disabled: !selected, maxVisibleChildren: formats.length,
        children: formats.map(item => ({ id: item.id, label: item.label, icon: item.id as NativeContextMenuIcon })) },
    ],
  }, point, action => onAction(action as ComposerMenuAction), onClose);
  if (nativeMenu) return null;
  return <ContextMenuSurface label={translate("输入框操作")} point={point} onClose={onClose} restoreFocus={restoreFocus}>
    <ContextMenuPanel>
      {clipboard.map(({ id, label, Icon }) => <button key={id} type="button" role="menuitem"
        disabled={id !== "paste" && !selected} onMouseEnter={() => setExpanded(false)} onClick={() => onAction(id)}>
        <Icon size={17} /><span>{label}</span>
      </button>)}
      <button ref={triggerRef} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={expanded}
        disabled={!selected} onMouseEnter={() => setExpanded(true)} onClick={() => setExpanded(true)}
        onKeyDown={event => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault(); event.stopPropagation(); setExpanded(true);
          setTimeout(() => submenuRef.current?.querySelector("button")?.focus(), 0);
        }}>
        <Type size={17} /><span>{translate("格式")}</span><ChevronRight className="context-menu-chevron" size={16} />
      </button>
    </ContextMenuPanel>
    {expanded && <div ref={submenuRef} onKeyDown={event => {
      if (event.key !== "ArrowLeft") {
        if (event.key === "Escape" || event.key === "Tab") return;
        handleMenuKeyboard(event, onClose); event.stopPropagation(); return;
      }
      event.preventDefault(); event.stopPropagation(); setExpanded(false); triggerRef.current?.focus();
    }}><ContextMenuPanel submenu role="menu" aria-label={translate("格式")}>
      {formats.map(({ id, label, Icon }) => <button key={id} type="button" role="menuitem" onClick={() => onAction(id)}>
        <Icon size={17} /><span>{label}</span>
      </button>)}
    </ContextMenuPanel></div>}
  </ContextMenuSurface>;
}
