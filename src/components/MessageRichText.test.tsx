import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageRichText } from "./MessageRichText";

describe("MessageRichText Telegram links", () => {
  it("keeps an uncached quoted sender clickable and displays it as a mention", () => {
    const html = renderToStaticMarkup(<MessageRichText text={"lucy\n什么🤔\n。"} entities={[
      { kind: "blockquote", offset: 0, length: "lucy\n什么🤔".length },
      { kind: "mentionName", offset: 0, length: 4, userId: "12345" },
    ]} />);
    expect(html).toContain('href="tg://user?id=12345">@lucy</a>');
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

  it("renders a schemeless public profile link as an @username mention", () => {
    const link = "t.me/sylphiette_grayrat_bot";
    const html = renderToStaticMarkup(
      <MessageRichText
        text={`${link} `}
        entities={[{ offset: 0, length: link.length, kind: "url" }]}
      />,
    );

    expect(html).toContain('href="https://t.me/sylphiette_grayrat_bot"');
    expect(html).toContain('>@sylphiette_grayrat_bot</a> ');
    expect(html).not.toContain('>t.me/sylphiette_grayrat_bot</a>');
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
