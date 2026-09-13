import { expect, it } from "vitest";
import { TdFileStateCache } from "./tdFileStateCache";

it("reconciles delayed snapshots and permits a later cache eviction", () => {
  const cache = new TdFileStateCache();
  const active = { "@type": "file", id: 7, local: { is_downloading_active: true }, remote: {} };
  const message = { photo: { sizes: [{ photo: active }] } };
  const completed = { ...active, local: { is_downloading_active: false, is_downloading_completed: true, path: "photo.jpg" } };
  cache.observe(message);
  cache.observe(completed);
  cache.observe(active);
  expect(cache.resolve(message).photo.sizes[0].photo).toBe(completed);
  const evicted = { ...active, local: { is_downloading_active: false, is_downloading_completed: false, path: "" } };
  cache.observe(evicted);
  expect(cache.resolve(completed)).toBe(evicted);
  expect(message.photo.sizes[0].photo).toBe(active);
  cache.clear();
  expect(cache.resolve(message)).toBe(message);
});

it("bounds file metadata and retains unchanged object identity", () => {
  const cache = new TdFileStateCache(2);
  const files = [1, 2, 3].map(id => ({ "@type": "file", id, local: {} }));
  cache.observe(files);
  const first = { ...files[0] };
  expect(cache.resolve(first)).toBe(first);
  expect(cache.resolve({ ...files[2] })).toBe(files[2]);
  const text = { content: { text: "unchanged" } };
  expect(cache.resolve(text)).toBe(text);
});
