import { en } from "./en";

export const zhCN = Object.fromEntries(
  Object.keys(en).map((key) => [key, key]),
) as Record<keyof typeof en, string>;
