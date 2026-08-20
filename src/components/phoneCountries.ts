import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/min";

export interface PhoneCountry {
  code: CountryCode;
  callingCode: string;
  name: string;
}

const displayNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
const collator = new Intl.Collator("zh-CN", { usage: "sort" });

const preferredNames: Partial<Record<CountryCode, string>> = {
  CN: "中国",
  HK: "中国香港",
  MO: "中国澳门",
  TW: "中国台湾",
};

export const phoneCountries: PhoneCountry[] = getCountries()
  .map((code) => ({
    code,
    callingCode: getCountryCallingCode(code),
    name: preferredNames[code] ?? displayNames.of(code) ?? code,
  }))
  .sort((left, right) => collator.compare(left.name, right.name));

export const defaultPhoneCountry = phoneCountries.find((country) => country.code === "CN")
  ?? phoneCountries[0];

const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase("zh-CN")
  .replaceAll(" ", "");

export const filterPhoneCountries = (query: string) => {
  const normalized = normalizeSearch(query);
  if (!normalized) return phoneCountries;
  const dialingQuery = normalized.startsWith("+") ? normalized : `+${normalized}`;
  return phoneCountries.filter((country) => (
    normalizeSearch(country.name).includes(normalized) ||
    country.code.toLocaleLowerCase().includes(normalized) ||
    `+${country.callingCode}`.startsWith(dialingQuery)
  ));
};

export const composePhoneNumber = (country: PhoneCountry, nationalNumber: string) => {
  const digits = nationalNumber.replace(/\D/g, "");
  if (!digits) return "";
  return parsePhoneNumberFromString(digits, country.code)?.number
    ?? `+${country.callingCode}${digits}`;
};
