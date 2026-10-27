/** Reverse references for owners with one small avatar; replacement and removal are O(1). */
export class FileReferenceIndex {
  private files = new Map<string, number>();
  private owners = new Map<number, Set<string>>();

  set(owner: string, fileId: number | undefined) {
    const previous = this.files.get(owner);
    if (previous === fileId) return;
    if (previous !== undefined) {
      const references = this.owners.get(previous);
      references?.delete(owner);
      if (!references?.size) this.owners.delete(previous);
      this.files.delete(owner);
    }
    if (fileId === undefined) return;
    this.files.set(owner, fileId);
    const references = this.owners.get(fileId) ?? new Set<string>();
    references.add(owner);
    this.owners.set(fileId, references);
  }

  forFile(fileId: number) {
    return this.owners.get(fileId) ?? [];
  }

  clear() {
    this.files.clear();
    this.owners.clear();
  }
}
