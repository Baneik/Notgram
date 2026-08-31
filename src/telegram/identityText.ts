import { translate } from "../i18n";
const UNSAFE_IDENTITY_CHARACTERS = /[\p{M}\p{C}]/gu;
const REPEATED_SPACES = / +/g;

let zalgoTextBlockingEnabled = true;

export const setZalgoTextBlockingEnabled = (enabled: boolean) => {
  zalgoTextBlockingEnabled = enabled;
};

const comparableIdentityText = (value: string) => value
  .normalize("NFKC")
  .trim()
  .replace(REPEATED_SPACES, " ");

export const normalizeIdentityText = (value: string) => {
  if (!zalgoTextBlockingEnabled) return value.trim();
  return value
    .normalize("NFKC")
    .replace(UNSAFE_IDENTITY_CHARACTERS, "")
    .trim()
    .replace(REPEATED_SPACES, " ");
};

export const sanitizeIdentityText = (
  value: string,
  fallback: string,
  maximum = 128,
) => {
  const normalized = normalizeIdentityText(value);
  if (!zalgoTextBlockingEnabled) return normalized || fallback;
  const bounded = [...normalized].slice(0, Math.max(0, maximum)).join("");
  return bounded || fallback;
};

export const identityTextField = (
  value: string,
  maximum: number,
  label: string,
  required = false,
) => {
  const normalized = normalizeIdentityText(value);
  if (zalgoTextBlockingEnabled && normalized !== comparableIdentityText(value)) {
    throw new Error(translate("{{value0}}包含不支持的字符", { value0: label }));
  }
  if ((required && !normalized) || [...normalized].length > maximum) {
    throw new Error(translate("{{value0}}格式不正确", { value0: label }));
  }
  return normalized;
};
