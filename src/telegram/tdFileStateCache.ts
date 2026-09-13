import { asTdObject, tdNumber, type TdObject } from "./tdlibMapper";

const fileId = (value: TdObject) => value["@type"] === "file" || ("local" in value && "remote" in value)
  ? tdNumber(value.id)
  : undefined;

/** File state follows native receive order, independently of async message hydration. */
export class TdFileStateCache {
  private files = new Map<number, TdObject>();
  private observed = new WeakSet<object>();

  constructor(private readonly limit = 20_000) {}

  observe(value: unknown) {
    if (!value || typeof value !== "object" || this.observed.has(value)) return;
    this.observed.add(value);
    if (Array.isArray(value)) {
      for (const item of value) this.observe(item);
      return;
    }
    const object = value as TdObject;
    const id = fileId(object);
    if (id !== undefined) {
      this.files.delete(id);
      this.files.set(id, object);
      if (this.files.size > this.limit) this.files.delete(this.files.keys().next().value!);
      return;
    }
    for (const item of Object.values(object)) this.observe(item);
  }

  resolve<T>(value: T): T {
    if (Array.isArray(value)) {
      const items = value.map(item => this.resolve(item));
      return (items.some((item, index) => item !== value[index]) ? items : value) as T;
    }
    const object = asTdObject(value);
    if (!object) return value;
    const id = fileId(object);
    if (id !== undefined) return (this.files.get(id) ?? value) as T;
    let result: TdObject | undefined;
    for (const [key, child] of Object.entries(object)) {
      const resolved = this.resolve(child);
      if (resolved !== child) (result ??= { ...object })[key] = resolved;
    }
    return (result ?? value) as T;
  }

  clear() {
    this.files.clear();
    this.observed = new WeakSet();
  }
}
