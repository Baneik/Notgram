import { describe, expect, it } from "vitest";
import {
  composePhoneNumber,
  defaultPhoneCountry,
  filterPhoneCountries,
  phoneCountries,
} from "./phoneCountries";

describe("phone country helpers", () => {
  it("provides complete country calling-code data with China as the default", () => {
    expect(phoneCountries.length).toBeGreaterThan(200);
    expect(defaultPhoneCountry).toMatchObject({ code: "CN", callingCode: "86", name: "中国" });
  });

  it("searches localized country names, ISO codes, and calling codes", () => {
    expect(filterPhoneCountries("中国").map((country) => country.code)).toContain("CN");
    expect(filterPhoneCountries("jp").map((country) => country.code)).toContain("JP");
    expect(filterPhoneCountries("+81").map((country) => country.code)).toEqual(["JP"]);
  });

  it("combines country and national segments into international numbers", () => {
    const china = phoneCountries.find((country) => country.code === "CN")!;
    const unitedKingdom = phoneCountries.find((country) => country.code === "GB")!;
    expect(composePhoneNumber(china, "138 0013 8000")).toBe("+8613800138000");
    expect(composePhoneNumber(unitedKingdom, "020 7946 0018")).toBe("+442079460018");
  });
});
