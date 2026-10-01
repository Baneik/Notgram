import type { Plugin, Processor } from "unified";

/** Cache parser output, never React elements or transformed trees. Each caller
 * owns a copy because downstream plugins are allowed to mutate their input. */
export const createMarkdownParseCache = (maxEntries = 256, maxCharacters = 512_000) => {
  const trees = new Map<string, { tree: ReturnType<NonNullable<Processor["parser"]>>; size: number }>();
  let characters = 0;
  const clear = () => { trees.clear(); characters = 0; };
  const plugin: Plugin = function() {
    const parser = this.parser;
    if (!parser) return;
    this.parser = (source, file) => {
      const cached = trees.get(source);
      if (cached) {
        trees.delete(source);
        trees.set(source, cached);
        return structuredClone(cached.tree);
      }
      const tree = parser(source, file);
      if (source.length <= maxCharacters) {
        trees.set(source, { tree: structuredClone(tree), size: source.length });
        characters += source.length;
        while (trees.size > maxEntries || characters > maxCharacters) {
          const oldest = trees.keys().next().value!;
          characters -= trees.get(oldest)!.size;
          trees.delete(oldest);
        }
      }
      return tree;
    };
  };
  return { plugin, clear };
};
