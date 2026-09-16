import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramStore } from "../store/telegramStore";
import { retainedMessageQuote } from "../telegram/retainedMessages";
import { MessageRichText } from "./MessageRichText";

afterEach(() => vi.restoreAllMocks());

describe("MessageRichText Telegram links", () => {
  it.each(["管理员", "群主", ""])("uses the quoted user's role in the message's chat (label: %s)", (label) => {
    const initialState = telegramStore.getInitialState();
    vi.spyOn(telegramStore, "getInitialState").mockReturnValue({
      ...initialState,
      activeChatId: "other-chat",
      chatAdministratorLabels: new Map([["source-chat", { "12345": label }]]),
    });
    const quote = retainedMessageQuote({ kind: "text", text: "什么🤔" }, "Lucy", undefined, "12345");
    const html = renderToStaticMarkup(<MessageRichText {...quote} chatId="source-chat" />);
    expect(html).toContain('href="tg://user?id=12345" class="message-mention is-administrator">Lucy</a>\n什么🤔');
    for (const chatId of ["other-chat", undefined]) {
      const otherHtml = renderToStaticMarkup(<MessageRichText {...quote} chatId={chatId} />);
      expect(otherHtml).not.toContain("is-administrator");
      expect(otherHtml).toContain('href="tg://user?id=12345" class="message-mention">Lucy</a>\n什么🤔');
    }
  });

  it.each(["lucy", "@lucy"])("keeps an uncached quoted sender %s clickable without an @ prefix", (author) => {
    const html = renderToStaticMarkup(<MessageRichText text={`${author}\n什么🤔\n。`} entities={[
      { kind: "blockquote", offset: 0, length: `${author}\n什么🤔`.length },
      { kind: "mentionName", offset: 0, length: author.length, userId: "12345" },
    ]} />);
    expect(html).toContain('href="tg://user?id=12345" class="message-mention">lucy</a>');
    expect(html).toContain("什么🤔</span></span>。");
  });

  it.each([false, true])("consumes the block separator with a newline inside the entity: %s", (inside) => {
    const html = renderToStaticMarkup(<MessageRichText text={"before\nquote\nafter"} entities={[
      { kind: "blockquote", offset: 7, length: inside ? 6 : 5 },
      { kind: "bold", offset: 13, length: 5 },
    ]} />);
    expect(html).toContain('>before<span class="rich-blockquote');
    expect(html).toContain('>quote</span></span><strong>after</strong>');
  });

  it("preserves intentional blank lines, quote line breaks and following entity offsets", () => {
    const text = "first\nsecond\n\nreply";
    const html = renderToStaticMarkup(<MessageRichText text={text} entities={[
      { kind: "blockquote", offset: 0, length: "first\nsecond".length },
      { kind: "bold", offset: text.indexOf("reply"), length: 5 },
    ]} />);
    expect(html).toContain('>first\nsecond</span></span>\n<strong>reply</strong>');
  });

  it("renders a schemeless public link as a URL instead of a mention", () => {
    const link = "t.me/sylphiette_grayrat_bot";
    const html = renderToStaticMarkup(
      <MessageRichText
        text={`${link} `}
        entities={[{ offset: 0, length: link.length, kind: "url" }]}
      />,
    );

    expect(html).toContain('href="https://t.me/sylphiette_grayrat_bot"');
    expect(html).toContain('>t.me/sylphiette_grayrat_bot</a> ');
    expect(html).not.toContain('>@sylphiette_grayrat_bot</a>');
  });

  it("keeps post and parameterized links visible without losing semantics", () => {
    const links = [
      "t.me/release_channel/123",
      "t.me/notgram_bot?start=verify",
    ];

    for (const link of links) {
      const html = renderToStaticMarkup(
        <MessageRichText
          text={link}
          entities={[{ offset: 0, length: link.length, kind: "url" }]}
        />,
      );
      expect(html).toContain(`>${link}</a>`);
    }
  });
});
