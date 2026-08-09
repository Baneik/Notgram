const EXECUTABLE_EXTENSIONS = new Set([
  "app", "apk", "bat", "bin", "cmd", "com", "deb", "dmg", "exe", "fish", "jar",
  "js", "jse", "lnk", "msi", "msp", "msix", "pkg", "ps1", "psd1", "psm1", "reg",
  "rpm", "run", "scr", "sh", "vbe", "vbs", "wsf", "wsh", "zsh",
]);

export const formatFileSize = (bytes?: number) => {
  if (!Number.isFinite(bytes) || (bytes ?? 0) <= 0) return undefined;
  const value = bytes!;
  const decimal = (amount: number, places: number) => amount.toFixed(places).replace(/\.0+$/, "");
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${decimal(value / 1024, value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 ** 3) return `${decimal(value / 1024 ** 2, value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${decimal(value / 1024 ** 3, value < 10 * 1024 ** 3 ? 1 : 0)} GB`;
};

export const isExecutableFile = (fileName: string, mimeType?: string) => {
  const extension = fileName.trim().split(/[./\\]/).at(-1)?.toLocaleLowerCase();
  if (extension && EXECUTABLE_EXTENSIONS.has(extension)) return true;
  return /(?:executable|x-msdownload|x-sh|shellscript|java-archive)/i.test(mimeType ?? "");
};
