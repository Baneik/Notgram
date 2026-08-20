import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageRichText } from "./MessageRichText";

describe("MessageRichText Telegram links", () => {
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
