import { Editor, Extension, Mark, Node as EditorNode } from "@tiptap/core";
import { closeHistory, history, redo, undo } from "@tiptap/pm/history";
import { keymap } from "@tiptap/pm/keymap";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { MessageTextEntity } from "../telegram/types";
import type { ComposerFocus } from "../hooks/useComposerFocus";
import { translate } from "../i18n";
import { composerDocument, composerEntityKinds, composerFormattedText, composerFormatShortcut, isPastingIntoComposerLink, type ComposerFormat } from "../utils/composerFormatting";
import { ComposerContextMenu, type ComposerMenuAction } from "./ComposerContextMenu";
import type { ContextMenuPoint } from "./ContextMenuSurface";
import { readClipboardContent, waitForClipboardFocus } from "../utils/clipboard";
import { activeModal, isAvailableFocusTarget } from "../utils/focusPolicy";
import { composerDroppedImage, readComposerDroppedImage } from "../utils/composerDrop";

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
  Extension.create({ name: "composerMentionPresentation", addProseMirrorPlugins: () => [
    new Plugin({ props: {
      decorations: state => {
        const { text, entities } = composerFormattedText(state.doc.toJSON());
        // Hide only the presentation prefix; keep Telegram and editor offsets intact.
        return DecorationSet.create(state.doc, entities
          .filter(entity => (entity.kind === "mention" || entity.kind === "mentionName") &&
            entity.length > 1 && text[entity.offset] === "@")
          .map(entity => Decoration.inline(entity.offset + 1, entity.offset + 2, { class: "composer-mention-prefix" })));
      },
    } }),
  ] }),
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
  const clipboardActionRef = useRef<AbortController | null>(null);
  const imageDropRef = useRef<AbortController | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [menu, setMenu] = useState<{ point: ContextMenuPoint; from: number; to: number }>();
  const [clipboardError, setClipboardError] = useState(false);
  const [imageDropError, setImageDropError] = useState(false);
  const closeMenu = useCallback(() => setMenu(undefined), []);

  const applyFormat = useCallback((format: ComposerFormat) => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || editor.state.selection.empty || editor.view.composing) return;
    const from = Math.max(1, editor.state.selection.from);
    const to = Math.min(editor.state.doc.content.size - 1, editor.state.selection.to);
    if (format === "link") {
      const selected = editor.state.doc.textBetween(from, to, "", "\n");
      // Insert delimiters around the existing text to retain any overlapping marks.
      editor.view.dispatch(editor.state.tr.insertText("]()", to).insertText("[", from));
      editor.commands.setTextSelection(from + selected.length + 3);
    } else editor.commands.toggleMark(format);
  }, []);

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
          keydown: (view, event) => {
            // Let the IME and editor see the key without triggering app shortcuts.
            if (view.composing || event.isComposing || event.keyCode === 229) event.stopPropagation();
            return false;
          },
          beforeinput: (_view, event) => {
            const input = event as InputEvent;
            if (input.isComposing || input.inputType !== "insertText" || !input.data?.includes("\n")) return false;
            event.preventDefault(); pasteText(input.data); return true;
          },
          drop: (view, event) => {
            const data = event.dataTransfer;
            if (!data) return false;
            // File drops belong to the attachment surface, including their URL fallback.
            if (data.types.includes("Files")) { event.preventDefault(); return true; }
            const imageSource = composerDroppedImage(data);
            if (imageSource) {
              event.preventDefault();
              if (view.composing) return true;
              imageDropRef.current?.abort();
              const controller = new AbortController();
              imageDropRef.current = controller;
              const editor = editorRef.current;
              const document = view.state.doc;
              setImageDropError(false);
              void readComposerDroppedImage(imageSource, controller.signal).then(file => {
                if (!controller.signal.aborted && editor && !editor.isDestroyed && editorRef.current === editor &&
                  view.state.doc === document && !view.composing && !activeModal() &&
                  isAvailableFocusTarget(view.dom)) propsRef.current.onPasteFiles([file]);
              }).catch(() => {
                if (!controller.signal.aborted && editor && !editor.isDestroyed) setImageDropError(true);
              }).finally(() => {
                if (imageDropRef.current === controller) imageDropRef.current = null;
              });
              view.focus();
              return true;
            }
            // Preserve ProseMirror's move/copy transaction and marks for its own selection.
            if (view.dragging || !data.types.includes("text/plain")) return false;
            event.preventDefault();
            if (view.composing) return true;
            const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
            if (!position) return true;
            const limit = view.state.doc.content.size - 1;
            const caret = Math.max(1, Math.min(position.pos, limit));
            view.dispatch(closeHistory(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret))));
            pasteText(data.getData("text/plain"));
            view.dispatch(closeHistory(view.state.tr));
            view.focus();
            return true;
          },
        },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length) propsRef.current.onPasteFiles(files);
          else {
            const text = event.clipboardData?.getData("text/plain");
            if (text) pasteText(text);
          }
          return true;
        },
        handleKeyDown: (view, event) => {
          if (event.isComposing || view.composing) return false;
          const format = composerFormatShortcut(event);
          if (format) {
            // selectionchange can still be queued, including after IME commit.
            // Read the visible selection through ProseMirror's public DOM mapping.
            const selection = view.dom.ownerDocument.getSelection();
            if (selection?.anchorNode && selection.focusNode &&
              view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode)) {
              const limit = view.state.doc.content.size - 1;
              const anchor = Math.max(1, Math.min(view.posAtDOM(selection.anchorNode, selection.anchorOffset), limit));
              const head = Math.max(1, Math.min(view.posAtDOM(selection.focusNode, selection.focusOffset), limit));
              const range = TextSelection.create(view.state.doc, anchor, head);
              if (!range.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(range));
              applyFormat(format);
            }
            event.stopPropagation();
            return true;
          }
          if (event.key !== "Enter" || event.keyCode === 229) return false;
          view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.hardBreak.create(), true));
          return true;
        },
      },
      onUpdate: ({ editor: updated }) => {
        const formatted = composerFormattedText(updated.getJSON());
        updated.view.dom.dataset.empty = String(!formatted.text);
        propsRef.current.onChange(formatted.text, formatted.entities);
      },
    });
    editorRef.current = editor;
    const input = editor.view.dom as ComposerInputElement;
    Object.defineProperties(input, {
      value: { get: () => editorText(editor) },
      // Ctrl+A may select the document node; the adapter still exposes text offsets.
      selectionStart: { get: () => Math.max(0, editor.state.selection.from - 1) },
      selectionEnd: { get: () => Math.min(editor.state.doc.content.size - 2, editor.state.selection.to - 1) },
    });
    input.setSelectionRange = (start, end) => {
      const limit = editor.state.doc.content.size - 1;
      editor.commands.setTextSelection({ from: Math.max(1, Math.min(start + 1, limit)), to: Math.max(1, Math.min(end + 1, limit)) });
    };
    input.focusEditor = () => editor.view.focus();
    props.inputRef.current = input;
    input.setSelectionRange(current.value.length, current.value.length);
    return () => {
      clipboardActionRef.current?.abort();
      imageDropRef.current?.abort();
      if (props.inputRef.current === input) props.inputRef.current = null;
      editorRef.current = null;
      editor.destroy();
    };
  }, [applyFormat, pasteText, props.inputRef]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const input = editor.view.dom;
    input.setAttribute("aria-label", translate("消息内容"));
    input.setAttribute("aria-busy", String(props.busy));
    input.setAttribute("data-placeholder", props.placeholder);
    if (!editor.view.composing) {
      const content = composerDocument(props.value, props.entities);
      if (!editor.schema.nodeFromJSON(content).eq(editor.state.doc)) {
        editor.commands.setContent(content, { emitUpdate: false });
        editor.commands.setTextSelection(props.value.length + 1);
      }
    }
    input.dataset.empty = String(!editorText(editor));
  });

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
    clipboardActionRef.current?.abort();
    const controller = new AbortController();
    clipboardActionRef.current = controller;
    const cancel = () => controller.abort();
    const ownerDocument = editor.view.dom.ownerDocument;
    const changeFocus = (event: Event) => { if (event.target !== editor.view.dom) cancel(); };
    for (const type of ["pointerdown", "keydown", "compositionstart"]) ownerDocument.addEventListener(type, cancel, true);
    ownerDocument.addEventListener("focusin", changeFocus, true);
    const current = () => !controller.signal.aborted && !editor.isDestroyed && editorRef.current === editor &&
      isAvailableFocusTarget(editor.view.dom) && !activeModal() && !editor.view.composing &&
      editor.state.doc === document && editor.state.selection.eq(selection);
    try {
      await waitForClipboardFocus(controller.signal);
      if (!current()) return;
      if (action === "paste") {
        const { text, files } = await readClipboardContent();
        if (current()) {
          if (files.length) propsRef.current.onPasteFiles(files);
          else if (text) pasteText(text);
        }
      } else {
        await navigator.clipboard.writeText(editor.state.doc.textBetween(menu.from, menu.to, "", "\n"));
        if (action === "cut" && current()) editor.commands.deleteSelection();
      }
    } catch { if (!controller.signal.aborted && !editor.isDestroyed) setClipboardError(true); }
    finally {
      for (const type of ["pointerdown", "keydown", "compositionstart"]) ownerDocument.removeEventListener(type, cancel, true);
      ownerDocument.removeEventListener("focusin", changeFocus, true);
      if (clipboardActionRef.current === controller) clipboardActionRef.current = null;
    }
    restore();
  }, [applyFormat, closeMenu, menu, pasteText]);

  return <div className="composer-input-container"
    onKeyDownCapture={event => {
      const editor = editorRef.current;
      if (!editor?.view.dom.contains(event.target as globalThis.Node)) return;
      if (event.nativeEvent.isComposing || editor.view.composing || event.nativeEvent.keyCode === 229) return;
      props.onKeyDown(event);
    }}
    onCompositionStart={() => {
      // Preedit can be visible before it reaches the editor document or React state.
      if (editorRef.current) editorRef.current.view.dom.dataset.composing = "true";
      props.onCompositionStart();
    }}
    onCompositionEnd={() => {
      const editor = editorRef.current;
      if (editor) {
        editor.view.dom.dataset.composing = "false";
        editor.view.dom.dataset.empty = String(!editorText(editor));
      }
      props.onCompositionEnd(editor ? editorText(editor) : "");
    }}
    onFocus={props.onFocus}
    onBlur={() => props.onBlur(editorRef.current ? editorText(editorRef.current) : "")}
    onContextMenu={event => {
      const editor = editorRef.current;
      if (!editor?.view.dom.contains(event.target as globalThis.Node)) return;
      event.preventDefault();
      if (!editor || editor.view.composing) return;
      clipboardActionRef.current?.abort();
      const from = Math.max(1, editor.state.selection.from);
      const to = Math.min(editor.state.doc.content.size - 1, editor.state.selection.to);
      setMenu({ point: { x: event.clientX, y: event.clientY }, from, to });
    }}>
    <div ref={containerRef} />
    {clipboardError && <span className="composer-clipboard-error" role="alert">{translate("无法访问剪贴板，请使用键盘快捷键")}</span>}
    {imageDropError && <span className="composer-clipboard-error" role="alert">{translate("无法读取拖入的图片，请将图片保存为文件后拖入")}</span>}
    {menu && <ComposerContextMenu point={menu.point} selected={menu.from !== menu.to} colorTheme={props.colorTheme}
      onAction={action => void runMenuAction(action)} onClose={closeMenu} restoreFocus={restoreFocus} />}
  </div>;
}
