import { Clock3, Images, LoaderCircle, Search, Sticker, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEventHandler,
} from "react";
import { useTelegramStore } from "../store/telegramStore";
import { autoplayAllowed } from "../utils/motionPreference";
import { usePreferencesStore } from "../store/preferencesStore";
import type {
  EmojiPickerAsset,
  EmojiPickerCatalog,
  StickerSet,
} from "../telegram/types";
import { EmojiAssetVisual } from "./EmojiAssetVisual";

type PickerTab = "emoji" | "sticker" | "animation";

interface EmojiPickerProps {
  chatId: string;
  replyToMessageId?: string;
  onEmoji: (emoji: string) => void;
  onClose: () => void;
  onRequestComposerFocus: () => void;
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
}

const RECENT_EMOJI_KEY = "notgram.recent-emojis";
const RECENT_STICKERS = "recent";

const emojiGroups = [
  {
    id: "faces",
    title: "表情与人物",
    emojis: "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫣 🤭 🫢 🫡 🤫 🫠 🤥 😶 🫥 😐 🫤 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🤢 🤮 🤧 😷 🤒 🤕".split(" "),
  },
  {
    id: "gestures",
    title: "手势与身体",
    emojis: "👋 🤚 🖐️ ✋ 🖖 🫱 🫲 🫳 🫴 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 🫵 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 👃 🧠 🫀 🫁 🦷 👀 👁️ 👅 👄".split(" "),
  },
  {
    id: "animals",
    title: "动物与自然",
    emojis: "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐻‍❄️ 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🪲 🦋 🐌 🐞 🐜 🪰 🪱 🐢 🐍 🦎 🐙 🦑 🦐 🦞 🦀 🐠 🐟 🐡 🐬 🐳 🌵 🎄 🌲 🌳 🌴 🪴 🌱 🌿 ☘️ 🍀 🍁 🍂 🍃 🌸 🌼 🌻 🌞 🌝 🌚 ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ☁️ ❄️".split(" "),
  },
  {
    id: "food",
    title: "食物与饮品",
    emojis: "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥠 🍦 🍧 🍨 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 ☕ 🍵 🧋 🥤 🍺 🍻 🥂 🍷".split(" "),
  },
  {
    id: "activity",
    title: "活动与物品",
    emojis: "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🎱 🏓 🏸 🥅 🏒 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🎿 🏂 🪂 🏋️ 🤸 ⛹️ 🤺 🏇 🧘 🎮 🕹️ 🎲 ♟️ 🎯 🎳 🎸 🎹 🎺 🎻 🥁 🎬 🎨 🚗 🚕 🚌 🚑 🚒 🚲 ✈️ 🚀 🛸 ⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 📷 🎥 📞 💡 📚 ✏️ 📝 📌 📎 🔒 🔑 🔨 🧰 🧲 🧪 💊 🎁 🎈 🎉 ✅ ❌ ❗ ❓ 💯".split(" "),
  },
  {
    id: "symbols",
    title: "符号与旗帜",
    emojis: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ ▶️ ⏸️ ⏹️ ⏺️ ⏭️ ⏮️ 🔀 🔁 🔂 ➕ ➖ ➗ ✖️ ♾️ ‼️ ⁉️ ❔ ❕ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ©️ ®️ ™️ 🏁 🚩 🎌 🏳️ 🏴".split(" "),
  },
] as const;

const readRecentEmojis = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string").slice(0, 36)
      : [];
  } catch {
    return [];
  }
};

function LazyEmojiAsset({
  asset,
  onSelect,
  autoplay,
}: {
  asset: EmojiPickerAsset;
  onSelect: (asset: EmojiPickerAsset) => void;
  autoplay: boolean;
}) {
  const label = asset.kind === "animation" ? "发送 GIF" : `发送贴纸 ${asset.emoji ?? ""}`.trim();

  return (
    <button
      className="emoji-asset-button"
      type="button"
      aria-label={label}
      title={label}
      onClick={() => onSelect(asset)}
    >
      <EmojiAssetVisual asset={asset} autoplay={autoplay} label={label} />
    </button>
  );
}

export function EmojiPicker({
  chatId,
  replyToMessageId,
  onEmoji,
  onClose,
  onRequestComposerFocus,
  onPointerEnter,
  onPointerLeave,
}: EmojiPickerProps) {
  const loadEmojiPicker = useTelegramStore((state) => state.loadEmojiPicker);
  const loadStickerSet = useTelegramStore((state) => state.loadStickerSet);
  const searchStickers = useTelegramStore((state) => state.searchStickers);
  const sendSticker = useTelegramStore((state) => state.sendSticker);
  const sendAnimation = useTelegramStore((state) => state.sendAnimation);
  const autoplayAnimations = usePreferencesStore((state) => autoplayAllowed(
    state.autoplayAnimations,
    state,
  ));
  const panelRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<PickerTab>("sticker");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<EmojiPickerCatalog>();
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [recentEmojis, setRecentEmojis] = useState(readRecentEmojis);
  const [selectedStickerSetId, setSelectedStickerSetId] = useState(RECENT_STICKERS);
  const [stickerSets, setStickerSets] = useState<Map<string, StickerSet>>(() => new Map());
  const [stickerSetLoading, setStickerSetLoading] = useState<string>();
  const [failedStickerSetIds, setFailedStickerSetIds] = useState<Set<string>>(() => new Set());
  const [stickerSearchResults, setStickerSearchResults] = useState<EmojiPickerAsset[]>([]);
  const [sendingAssetId, setSendingAssetId] = useState<string>();

  useEffect(() => {
    let active = true;
    void loadEmojiPicker().then((nextCatalog) => {
      if (!active) return;
      setCatalog(nextCatalog);
      setCatalogLoading(false);
    });
    return () => { active = false; };
  }, [loadEmojiPicker]);

  useEffect(() => {
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".emoji-picker, .emoji-trigger")) return;
      onClose();
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [onClose]);

  useEffect(() => {
    if (tab !== "sticker" || selectedStickerSetId === RECENT_STICKERS) return;
    if (stickerSets.has(selectedStickerSetId) || stickerSetLoading === selectedStickerSetId) return;
    if (failedStickerSetIds.has(selectedStickerSetId)) return;
    setStickerSetLoading(selectedStickerSetId);
    void loadStickerSet(selectedStickerSetId).then((stickerSet) => {
      if (stickerSet) {
        setStickerSets((current) => new Map(current).set(stickerSet.id, stickerSet));
      } else {
        setFailedStickerSetIds((current) => new Set(current).add(selectedStickerSetId));
      }
      setStickerSetLoading((current) => current === selectedStickerSetId ? undefined : current);
    });
  }, [failedStickerSetIds, loadStickerSet, selectedStickerSetId, stickerSetLoading, stickerSets, tab]);

  useEffect(() => {
    if (tab !== "sticker" || !query.trim()) {
      setStickerSearchResults([]);
      return;
    }
    let active = true;
    const timer = globalThis.setTimeout(() => {
      void searchStickers(query, chatId).then((results) => {
        if (active) setStickerSearchResults(results);
      });
    }, 250);
    return () => {
      active = false;
      globalThis.clearTimeout(timer);
    };
  }, [chatId, query, searchStickers, tab]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEmojiGroups = useMemo(() => {
    const groups = recentEmojis.length > 0
      ? [{ id: "recent", title: "最近使用", emojis: recentEmojis }, ...emojiGroups]
      : [...emojiGroups];
    if (!normalizedQuery) return groups;
    return groups.map((group) => ({
      ...group,
      emojis: group.emojis.filter((emoji) => emoji.includes(normalizedQuery)),
    })).filter((group) => group.emojis.length > 0);
  }, [normalizedQuery, recentEmojis]);

  const stickerAssets = normalizedQuery
    ? stickerSearchResults
    : selectedStickerSetId === RECENT_STICKERS
      ? catalog?.recentStickers ?? []
      : stickerSets.get(selectedStickerSetId)?.stickers ?? [];

  const rememberEmoji = useCallback((emoji: string) => {
    const next = [emoji, ...recentEmojis.filter((candidate) => candidate !== emoji)].slice(0, 36);
    setRecentEmojis(next);
    try { localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(next)); } catch { /* noop */ }
    onEmoji(emoji);
    onRequestComposerFocus();
  }, [onEmoji, onRequestComposerFocus, recentEmojis]);

  const sendAsset = useCallback(async (asset: EmojiPickerAsset) => {
    if (sendingAssetId) return;
    setSendingAssetId(asset.id);
    const sent = asset.kind === "animation"
      ? await sendAnimation(asset, replyToMessageId)
      : await sendSticker(asset, replyToMessageId);
    setSendingAssetId(undefined);
    if (sent) {
      onClose();
      onRequestComposerFocus();
    }
  }, [onClose, onRequestComposerFocus, replyToMessageId, sendAnimation, sendSticker, sendingAssetId]);

  const closeAndRestoreComposerFocus = () => {
    onClose();
    onRequestComposerFocus();
  };

  const placeholder = tab === "emoji"
    ? "搜索 Emoji"
    : tab === "sticker" ? "搜索贴纸" : "搜索 GIF";

  return (
    <section
      id="emoji-picker"
      ref={panelRef}
      className="emoji-picker"
      role="dialog"
      aria-label="表情、贴纸与 GIF"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <header className="emoji-picker-tabs" role="tablist" aria-label="内容类型">
        <button className={tab === "emoji" ? "is-active" : ""} type="button" role="tab" aria-selected={tab === "emoji"} onClick={() => { setTab("emoji"); setQuery(""); }}>
          Emoji
        </button>
        <button className={tab === "sticker" ? "is-active" : ""} type="button" role="tab" aria-selected={tab === "sticker"} onClick={() => { setTab("sticker"); setQuery(""); }}>
          贴纸
        </button>
        <button className={tab === "animation" ? "is-active" : ""} type="button" role="tab" aria-selected={tab === "animation"} onClick={() => { setTab("animation"); setQuery(""); }}>
          GIF 动态图
        </button>
        <button className="emoji-picker-close" type="button" aria-label="关闭表情面板" title="关闭" onClick={closeAndRestoreComposerFocus}>
          <X size={17} />
        </button>
      </header>

      <label className="emoji-picker-search">
        <Search size={16} strokeWidth={1.8} />
        <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} aria-label={placeholder} />
      </label>

      <div className="emoji-picker-content">
        {tab === "emoji" ? (
          visibleEmojiGroups.length > 0 ? visibleEmojiGroups.map((group) => (
            <section className="emoji-section" key={group.id}>
              <h3>{group.title}</h3>
              <div className="emoji-grid">
                {group.emojis.map((emoji) => (
                  <button type="button" key={`${group.id}:${emoji}`} aria-label={`插入 ${emoji}`} onClick={() => rememberEmoji(emoji)}>{emoji}</button>
                ))}
              </div>
            </section>
          )) : <div className="emoji-picker-empty">没有匹配的 Emoji</div>
        ) : catalogLoading ? (
          <div className="emoji-picker-empty"><LoaderCircle className="spin" size={20} />正在读取你的内容</div>
        ) : tab === "sticker" ? (
          <section className="emoji-section">
            <h3>{normalizedQuery ? "搜索结果" : selectedStickerSetId === RECENT_STICKERS ? "最近使用" : stickerSets.get(selectedStickerSetId)?.title ?? "贴纸包"}</h3>
            {stickerSetLoading === selectedStickerSetId ? (
              <div className="emoji-picker-empty"><LoaderCircle className="spin" size={20} />正在加载贴纸包</div>
            ) : failedStickerSetIds.has(selectedStickerSetId) ? (
              <div className="emoji-picker-empty emoji-picker-error">
                <span>贴纸包加载失败</span>
                <button
                  type="button"
                  onClick={() => setFailedStickerSetIds((current) => {
                    const next = new Set(current);
                    next.delete(selectedStickerSetId);
                    return next;
                  })}
                >重试</button>
              </div>
            ) : stickerAssets.length > 0 ? (
              <div className="emoji-asset-grid">
                {stickerAssets.map((asset) => <LazyEmojiAsset key={asset.id} asset={asset} autoplay={autoplayAnimations} onSelect={(value) => void sendAsset(value)} />)}
              </div>
            ) : <div className="emoji-picker-empty">没有可用的贴纸</div>}
          </section>
        ) : (
          <section className="emoji-section">
            <h3>已保存的 GIF</h3>
            {(catalog?.savedAnimations ?? []).filter((asset) => !normalizedQuery || asset.fileName.toLocaleLowerCase().includes(normalizedQuery)).length > 0 ? (
              <div className="emoji-animation-grid">
                {(catalog?.savedAnimations ?? []).filter((asset) => !normalizedQuery || asset.fileName.toLocaleLowerCase().includes(normalizedQuery)).map((asset) => (
                  <LazyEmojiAsset key={asset.id} asset={asset} autoplay={autoplayAnimations} onSelect={(value) => void sendAsset(value)} />
                ))}
              </div>
            ) : <div className="emoji-picker-empty">没有已保存的 GIF</div>}
          </section>
        )}
      </div>

      <footer className="emoji-picker-packs" aria-label="快捷分类">
        {tab === "emoji" ? (
          <>
            <button type="button" title="最近使用" onClick={() => panelRef.current?.querySelector(".emoji-picker-content")?.scrollTo({ top: 0 })}><Clock3 size={18} /></button>
            {emojiGroups.map((group, index) => (
              <button type="button" key={group.id} title={group.title} onClick={() => panelRef.current?.querySelectorAll<HTMLElement>(".emoji-section")[recentEmojis.length > 0 ? index + 1 : index]?.scrollIntoView({ block: "start" })}>
                <span>{group.emojis[0]}</span>
              </button>
            ))}
          </>
        ) : tab === "sticker" ? (
          <>
            <button className={selectedStickerSetId === RECENT_STICKERS ? "is-active" : ""} type="button" title="最近使用" onClick={() => { setQuery(""); setSelectedStickerSetId(RECENT_STICKERS); }}><Clock3 size={18} /></button>
            {(catalog?.stickerSets ?? []).map((stickerSet) => (
              <button className={selectedStickerSetId === stickerSet.id ? "is-active" : ""} type="button" key={stickerSet.id} title={stickerSet.title} onClick={() => { setQuery(""); setSelectedStickerSetId(stickerSet.id); }}>
                {stickerSet.covers[0]
                  ? <EmojiAssetVisual asset={stickerSet.covers[0]} autoplay={false} label={stickerSet.title} className="sticker-pack-cover" />
                  : <Sticker size={18} />}
              </button>
            ))}
          </>
        ) : (
          <button className="is-active" type="button" title="已保存的 GIF"><Images size={18} /></button>
        )}
      </footer>

      {sendingAssetId && <div className="emoji-picker-sending" role="status"><LoaderCircle className="spin" size={18} />正在发送</div>}
    </section>
  );
}
