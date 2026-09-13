import { Editor, Extension, Mark, Node as EditorNode } from "@tiptap/core";
import { history, redo, undo } from "@tiptap/pm/history";
import { keymap } from "@tiptap/pm/keymap";
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { MessageTextEntity } from "../telegram/types";
import type { ComposerFocus } from "../hooks/useComposerFocus";
import { translate } from "../i18n";
import { composerDocument, composerEntityKinds, composerFormattedText, composerFormatShortcuts, isPastingIntoComposerLink, type ComposerFormat } from "../utils/composerFormatting";
import { ComposerContextMenu, type ComposerMenuAction } from "./ComposerContextMenu";
import type { ContextMenuPoint } from "./ContextMenuSurface";

export interface ComposerInputElement extends HTMLDivElement {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange: (start: number, end: number) => void;
  focusEditor: () => void;
}

const tags: Record<string, string> = { bold: "strong", italic: "em", underline: "u", strikethrough: "s", code: "code", pre: "code" };
const extensions = [
  EditorNode.create({ name: "doc", topNode: true, content: "paragraph" }),
  EditorNode.create({ name: "paragraph", content: "inline*", group: "block", whitespace: "pre",
    parseHTML: () => [{ tag: "p" }], renderHTML: () => ["p", 0] }),
  EditorNode.create({ name: "text", group: "inline" }),
  EditorNode.create({ name: "hardBreak", inline: true, group: "inline", selectable: false,
    parseHTML: () => [{ tag: "br" }], renderHTML: () => ["br"] }),
  ...composerEntityKinds.map(kind => Mark.create({
    name: kind, inclusive: false,
    addAttributes: () => ({ entity: { default: {}, rendered: false } }),
    parseHTML: () => [{ tag: `[data-composer-entity="${kind}"]` }],
    renderHTML: () => [tags[kind] ?? "span", { "data-composer-entity": kind }, 0],
  })),
  Extension.create({ name: "composerHistory", addProseMirrorPlugins: () => [
    history(), keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }),
  ] }),
];

const editorText = (editor: Editor) => editor.state.doc.textBetween(0, editor.state.doc.content.size, "", "\n");

interface Props {
  inputRef: RefObject<ComposerInputElement | null>;
  value: string;
  entities: readonly MessageTextEntity[];
  placeholder: string;
  busy: boolean;
  colorTheme: "light" | "dark";
  focus: ComposerFocus;
  onChange: (text: string, entities: MessageTextEntity[]) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPasteFiles: (files: File[]) => boolean;
  onCompositionStart: () => void;
  onCompositionEnd: (text: string) => void;
  onFocus: () => void;
  onBlur: (text: string) => void;
}

export function ComposerInput(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [menu, setMenu] = useState<{ point: ContextMenuPoint; from: number; to: number }>();
  const [clipboardError, setClipboardError] = useState(false);
  const closeMenu = useCallback(() => setMenu(undefined), []);

  const pasteText = useCallback((text: string) => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    const { from, to } = editor.state.selection;
    const completeLink = isPastingIntoComposerLink(editorText(editor), from - 1, to - 1);
    const marks = editor.state.storedMarks ?? editor.state.selection.$from.marks();
    const content = composerDocument(text.replace(/\r\n?/g, "\n"), []).content?.[0].content ?? [];
    editor.commands.insertContentAt({ from, to }, content.map(node => ({ ...node, marks: marks.map(mark => mark.toJSON()) })), { parseOptions: { preserveWhitespace: "full" } });
    if (completeLink) editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  }, []);

  useLayoutEffect(() => {
    const current = propsRef.current;
    const editor = new Editor({
      element: containerRef.current!, extensions, injectCSS: false,
      content: composerDocument(current.value, current.entities),
      editorProps: {
        attributes: { class: "composer-input", role: "textbox", "aria-multiline": "true", spellcheck: "true" },
        handleDOMEvents: {
          beforeinput: (_view, event) => {
            const input = event as InputEvent;
            if (input.isComposing || input.inputType !== "insertText" || !input.data?.includes("\n")) return false;
            event.preventDefault(); pasteText(input.data); return true;
          },
        },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length && propsRef.current.onPasteFiles(files)) return true;
          pasteText(event.clipboardData?.getData("text/plain") ?? "");
          return true;
        },
        handleKeyDown: (view, event) => {
          if (event.key !== "Enter" || event.isComposing || view.composing) return false;
          view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.hardBreak.create(), true));
          return true;
        },
      },
      onUpdate: ({ editor: updated }) => {
        const formatted = composerFormattedText(updated.getJSON());
        propsRef.current.onChange(formatted.text, formatted.entities);
      },
    });
    editorRef.current = editor;
    const input = editor.view.dom as ComposerInputElement;
    Object.defineProperties(input, {
      value: { get: () => editorText(editor) },
      selectionStart: { get: () => editor.state.selection.from - 1 },
      selectionEnd: { get: () => editor.state.selection.to - 1 },
    });
    input.setSelectionRange = (start, end) => {
      const limit = editor.state.doc.content.size - 1;
      editor.commands.setTextSelection({ from: Math.max(1, Math.min(start + 1, limit)), to: Math.max(1, Math.min(end + 1, limit)) });
    };
    input.focusEditor = () => editor.view.focus();
    props.inputRef.current = input;
    input.setSelectionRange(current.value.length, current.value.length);
    return () => {
      if (props.inputRef.current === input) props.inputRef.current = null;
      editorRef.current = null;
      editor.destroy();
    };
  }, [pasteText, props.inputRef]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.view.composing) return;
    const content = composerDocument(props.value, props.entities);
    if (!editor.schema.nodeFromJSON(content).eq(editor.state.doc)) {
      editor.commands.setContent(content, { emitUpdate: false });
      editor.commands.setTextSelection(props.value.length + 1);
    }
    const input = editor.view.dom;
    input.setAttribute("aria-label", translate("消息内容"));
    input.setAttribute("aria-busy", String(props.busy));
    input.setAttribute("data-placeholder", props.placeholder);
    input.dataset.empty = String(!props.value);
  });

  const applyFormat = useCallback((format: ComposerFormat) => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || editor.state.selection.empty || editor.view.composing) return;
    const { from, to } = editor.state.selection;
    if (format === "link") {
      const selected = editor.state.doc.textBetween(from, to, "", "\n");
      // Insert delimiters around the existing text to retain any overlapping marks.
      editor.view.dispatch(editor.state.tr.insertText("]()", to).insertText("[", from));
      editor.commands.setTextSelection(from + selected.length + 3);
    } else editor.commands.toggleMark(format);
  }, []);

  const restoreFocus = useCallback(() => propsRef.current.focus.capture(true)(), []);
  const runMenuAction = useCallback(async (action: ComposerMenuAction) => {
    const editor = editorRef.current;
    if (!editor || !menu || editor.isDestroyed) return;
    editor.commands.setTextSelection({ from: menu.from, to: menu.to });
    const restore = propsRef.current.focus.capture(true);
    closeMenu();
    setClipboardError(false);
    if (!["cut", "copy", "paste"].includes(action)) {
      applyFormat(action as ComposerFormat); restore(); return;
    }
    // Clipboard access may outlive this conversation. Never mutate a replacement editor.
    const document = editor.state.doc;
    const selection = editor.state.selection;
    try {
      if (action === "paste") {
        const text = await navigator.clipboard.readText();
        if (!editor.isDestroyed && editorRef.current === editor && editor.state.doc === document && editor.state.selection.eq(selection)) pasteText(text);
      } else {
        await navigator.clipboard.writeText(editor.state.doc.textBetween(menu.from, menu.to, "", "\n"));
        if (action === "cut" && !editor.isDestroyed && editorRef.current === editor && editor.state.doc === document && editor.state.selection.eq(selection)) editor.commands.deleteSelection();
      }
    } catch { if (!editor.isDestroyed) setClipboardError(true); }
    restore();
  }, [applyFormat, closeMenu, menu, pasteText]);

  return <div className="composer-input-container"
    onKeyDownCapture={event => {
      const editor = editorRef.current;
      if (!editor?.view.dom.contains(event.target as globalThis.Node)) return;
      if (event.nativeEvent.isComposing || editor?.view.composing) return;
      const format = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
        ? composerFormatShortcuts[event.key.toLowerCase()] : undefined;
      if (format) { event.preventDefault(); event.stopPropagation(); applyFormat(format); return; }
      props.onKeyDown(event);
    }}
    onCompositionStart={props.onCompositionStart}
    onCompositionEnd={() => props.onCompositionEnd(editorRef.current ? editorText(editorRef.current) : "")}
    onFocus={props.onFocus}
    onBlur={() => props.onBlur(editorRef.current ? editorText(editorRef.current) : "")}
    onContextMenu={event => {
      const editor = editorRef.current;
      if (!editor?.view.dom.contains(event.target as globalThis.Node)) return;
      event.preventDefault();
      if (!editor || editor.view.composing) return;
      const { from, to } = editor.state.selection;
      setMenu({ point: { x: event.clientX, y: event.clientY }, from, to });
    }}>
    <div ref={containerRef} />
    {clipboardError && <span className="composer-clipboard-error" role="alert">{translate("无法访问剪贴板，请使用键盘快捷键")}</span>}
    {menu && <ComposerContextMenu point={menu.point} selected={menu.from !== menu.to} colorTheme={props.colorTheme}
      onAction={action => void runMenuAction(action)} onClose={closeMenu} restoreFocus={restoreFocus} />}
  </div>;
}
