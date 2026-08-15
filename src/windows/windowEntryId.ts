export const windowEntryId = (search = globalThis.location.search) => {
  const id = new URLSearchParams(search).get("id");
  if (!id) throw new Error("window identifier is missing");
  return id;
};
