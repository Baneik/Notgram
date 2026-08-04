import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { Clock3, Images, LoaderCircle, Search, Smile, Sticker, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTelegramStore } from "../store/telegramStore";
import type {
  EmojiPickerAsset,
  EmojiPickerCatalog,
  StickerSet,
} from "../telegram/types";
import { TgsSticker } from "./TgsSticker";

type PickerTab = "emoji" | "sticker" | "animation";

interface EmojiPickerProps {
  chatId: string;
  replyToMessageId?: string;
  onEmoji: (emoji: string) => void;
  onClose: () => void;
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

const assetSource = (path?: string) => {
  if (!path) return undefined;
  return isTauri() ? convertFileSrc(path) : path;
};

function LazyEmojiAsset({
  asset,
  onSelect,
}: {
  asset: EmojiPickerAsset;
  onSelect: (asset: EmojiPickerAsset) => void;
}) {
  const loadEmojiAsset = useTelegramStore((state) => state.loadEmojiAsset);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(Boolean(asset.previewDataUrl || asset.previewPath));
  const [loadedPath, setLoadedPath] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const button = buttonRef.current;
    if (!button || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "180px" });
    observer.observe(button);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || asset.previewDataUrl || asset.previewPath || asset.localPath) return;
    let active = true;
    void loadEmojiAsset(asset).then((path) => {
      if (active) setLoadedPath(path);
    });
    return () => { active = false; };
  }, [asset, loadEmojiAsset, visible]);

  const source = assetSource(asset.previewPath ?? asset.localPath ?? loadedPath) ?? asset.previewDataUrl;
  const usingFullAsset = !asset.previewPath && !asset.previewDataUrl && !asset.previewFileId;
  const label = asset.kind === "animation" ? "发送 GIF" : `发送贴纸 ${asset.emoji ?? ""}`.trim();

  return (
    <button
      ref={buttonRef}
      className="emoji-asset-button"
      type="button"
      aria-label={label}
      title={label}
      onClick={() => onSelect(asset)}
    >
      {!visible || (!source && !failed) ? <LoaderCircle className="spin" size={18} /> : failed ? (
        <span className="emoji-asset-fallback">{asset.emoji ?? "GIF"}</span>
      ) : usingFullAsset && asset.mimeType === "application/x-tgsticker" ? (
        <TgsSticker src={source!} label={label} autoplay onError={() => setFailed(true)} />
      ) : usingFullAsset && (asset.mimeType === "video/webm" || asset.kind === "animation") ? (
        <video src={source} muted autoPlay loop playsInline onError={() => setFailed(true)} />
      ) : (
        <img src={source} alt="" draggable={false} onError={() => setFailed(true)} />
      )}
    </button>
  );
}

export function EmojiPicker({
  chatId,
  replyToMessageId,
  onEmoji,
  onClose,
}: EmojiPickerProps) {
  const loadEmojiPicker = useTelegramStore((state) => state.loadEmojiPicker);
  const loadStickerSet = useTelegramStore((state) => state.loadStickerSet);
  const searchStickers = useTelegramStore((state) => state.searchStickers);
  const sendSticker = useTelegramStore((state) => state.sendSticker);
  const sendAnimation = useTelegramStore((state) => state.sendAnimation);
  const panelRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<PickerTab>("emoji");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<EmojiPickerCatalog>();
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [recentEmojis, setRecentEmojis] = useState(readRecentEmojis);
  const [selectedStickerSetId, setSelectedStickerSetId] = useState(RECENT_STICKERS);
  const [stickerSets, setStickerSets] = useState<Map<string, StickerSet>>(() => new Map());
  const [stickerSetLoading, setStickerSetLoading] = useState<string>();
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
    setStickerSetLoading(selectedStickerSetId);
    void loadStickerSet(selectedStickerSetId).then((stickerSet) => {
      if (stickerSet) {
        setStickerSets((current) => new Map(current).set(stickerSet.id, stickerSet));
      }
      setStickerSetLoading((current) => current === selectedStickerSetId ? undefined : current);
    });
  }, [loadStickerSet, selectedStickerSetId, stickerSetLoading, stickerSets, tab]);

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
  }, [onEmoji, recentEmojis]);

  const sendAsset = useCallback(async (asset: EmojiPickerAsset) => {
    if (sendingAssetId) return;
    setSendingAssetId(asset.id);
    const sent = asset.kind === "animation"
      ? await sendAnimation(asset, replyToMessageId)
      : await sendSticker(asset, replyToMessageId);
    setSendingAssetId(undefined);
    if (sent) onClose();
  }, [onClose, replyToMessageId, sendAnimation, sendSticker, sendingAssetId]);

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
        <button className="emoji-picker-close" type="button" aria-label="关闭表情面板" title="关闭" onClick={onClose}>
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
            ) : stickerAssets.length > 0 ? (
              <div className="emoji-asset-grid">
                {stickerAssets.map((asset) => <LazyEmojiAsset key={asset.id} asset={asset} onSelect={(value) => void sendAsset(value)} />)}
              </div>
            ) : <div className="emoji-picker-empty">没有可用的贴纸</div>}
          </section>
        ) : (
          <section className="emoji-section">
            <h3>已保存的 GIF</h3>
            {(catalog?.savedAnimations ?? []).filter((asset) => !normalizedQuery || asset.fileName.toLocaleLowerCase().includes(normalizedQuery)).length > 0 ? (
              <div className="emoji-animation-grid">
                {(catalog?.savedAnimations ?? []).filter((asset) => !normalizedQuery || asset.fileName.toLocaleLowerCase().includes(normalizedQuery)).map((asset) => (
                  <LazyEmojiAsset key={asset.id} asset={asset} onSelect={(value) => void sendAsset(value)} />
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
            <button className={selectedStickerSetId === RECENT_STICKERS ? "is-active" : ""} type="button" title="最近使用" onClick={() => setSelectedStickerSetId(RECENT_STICKERS)}><Clock3 size={18} /></button>
            {(catalog?.stickerSets ?? []).map((stickerSet) => (
              <button className={selectedStickerSetId === stickerSet.id ? "is-active" : ""} type="button" key={stickerSet.id} title={stickerSet.title} onClick={() => setSelectedStickerSetId(stickerSet.id)}>
                {stickerSet.covers[0]?.previewDataUrl ? <img src={stickerSet.covers[0].previewDataUrl} alt="" /> : <Sticker size={18} />}
              </button>
            ))}
          </>
        ) : (
          <button className="is-active" type="button" title="已保存的 GIF"><Images size={18} /></button>
        )}
        <span className="emoji-picker-type-mark">{tab === "emoji" ? <Smile size={17} /> : tab === "sticker" ? <Sticker size={17} /> : <Images size={17} />}</span>
      </footer>

      {sendingAssetId && <div className="emoji-picker-sending" role="status"><LoaderCircle className="spin" size={18} />正在发送</div>}
    </section>
  );
}
