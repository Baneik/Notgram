import { currentLanguage, translate } from "../i18n";
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

const preferredNames: Partial<Record<CountryCode, string>> = {
  get CN() { return translate("中国"); },
  get HK() { return translate("中国香港"); },
  get MO() { return translate("中国澳门"); },
  get TW() { return translate("中国台湾"); },
};

export const phoneCountries: PhoneCountry[] = getCountries()
  .map((code) => ({
    code,
    callingCode: getCountryCallingCode(code),
    get name() {
      return preferredNames[code] ?? new Intl.DisplayNames([currentLanguage()], { type: "region" }).of(code) ?? code;
    },
  }));

export const defaultPhoneCountry = phoneCountries.find((country) => country.code === "CN")
  ?? phoneCountries[0];

const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase(currentLanguage())
  .replaceAll(" ", "");

const sortCountries = (countries: PhoneCountry[]) => [...countries].sort((left, right) =>
  new Intl.Collator(currentLanguage(), { usage: "sort" }).compare(left.name, right.name),
);

export const filterPhoneCountries = (query: string) => {
  const normalized = normalizeSearch(query);
  if (!normalized) return sortCountries(phoneCountries);
  const dialingQuery = normalized.startsWith("+") ? normalized : `+${normalized}`;
  return sortCountries(phoneCountries.filter((country) => (
    normalizeSearch(country.name).includes(normalized) ||
    country.code.toLocaleLowerCase().includes(normalized) ||
    `+${country.callingCode}`.startsWith(dialingQuery)
  )));
};

export const composePhoneNumber = (country: PhoneCountry, nationalNumber: string) => {
  const digits = nationalNumber.replace(/\D/g, "");
  if (!digits) return "";
  return parsePhoneNumberFromString(digits, country.code)?.number
    ?? `+${country.callingCode}${digits}`;
};
