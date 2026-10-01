import { describe, expect, it } from "vitest";
import { unified, type Plugin } from "unified";
import { createMarkdownParseCache } from "./markdownParseCache";

describe("markdown parse ownership", () => {
  const fixture = (entries = 2, characters = 20) => {
    let parses = 0;
    const parser: Plugin = function() {
      this.parser = source => { parses++; return { type: "root", value: source }; };
    };
    const cache = createMarkdownParseCache(entries, characters);
    return { parse: (source: string) => unified().use(parser).use(cache.plugin).parse(source) as { type: string; value: string },
      parses: () => parses, clear: cache.clear };
  };

  it("reuses parser output across processors while isolating downstream mutations", () => {
    const { parse, parses } = fixture();
    const first = parse("**hello**");
    first.value = "mutated by a plugin";
    expect(parse("**hello**").value).toBe("**hello**");
    expect(parses()).toBe(1);
    expect(parse("**edited**").value).toBe("**edited**");
    expect(parses()).toBe(2);
  });

  it("bounds retention and clears cached source when the account changes", () => {
    const cache = fixture();
    cache.parse("one"); cache.parse("two"); cache.parse("one"); cache.parse("three"); cache.parse("two");
    expect(cache.parses()).toBe(4);
    cache.clear(); cache.parse("two");
    expect(cache.parses()).toBe(5);
  });

  it("does not retain an oversized message", () => {
    const cache = fixture(10, 4);
    cache.parse("oversized"); cache.parse("oversized");
    expect(cache.parses()).toBe(2);
    cache.parse("aa"); cache.parse("bbb"); cache.parse("aa");
    expect(cache.parses()).toBe(5);
  });
});
