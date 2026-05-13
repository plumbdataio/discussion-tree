import "./happydom.ts";
import { describe, test, expect, beforeAll } from "bun:test";
import i18n from "../../web/i18n.ts";
import { formatThreadTimestamp } from "../../web/utils/format.ts";

beforeAll(async () => {
  // i18n.init() is async — wait until it's ready before any test changes
  // the active language.
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => {
      i18n.on("initialized", () => resolve());
    });
  }
});

function setLang(lng: "en" | "ja") {
  return i18n.changeLanguage(lng);
}

describe("formatThreadTimestamp", () => {
  test("returns empty string for invalid input", async () => {
    await setLang("en");
    expect(formatThreadTimestamp("not-a-date")).toBe("");
  });

  test("returns empty string for the literal 'undefined'", async () => {
    await setLang("en");
    expect(formatThreadTimestamp("undefined")).toBe("");
  });

  test("en: same year → no year in the output", async () => {
    await setLang("en");
    const thisYear = new Date().getFullYear();
    const sample = new Date(thisYear, 5, 1, 9, 30).toISOString();
    const out = formatThreadTimestamp(sample);
    expect(out.includes(String(thisYear))).toBe(false);
    // Hour:minute should be present.
    expect(/\d\d?:\d\d/.test(out)).toBe(true);
  });

  test("en: different year → year appears", async () => {
    await setLang("en");
    const out = formatThreadTimestamp("2001-06-01T09:30:00Z");
    expect(out.includes("2001")).toBe(true);
  });

  test("ja: always includes the year (regardless of current year)", async () => {
    await setLang("ja");
    const thisYear = new Date().getFullYear();
    const sample = new Date(thisYear, 5, 1, 9, 30).toISOString();
    const out = formatThreadTimestamp(sample);
    expect(out.includes(String(thisYear))).toBe(true);
  });

  test("ja: also includes the year for older messages", async () => {
    await setLang("ja");
    const out = formatThreadTimestamp("2001-06-01T09:30:00Z");
    expect(out.includes("2001")).toBe(true);
  });

  test("uses 24-hour clock (no AM/PM)", async () => {
    await setLang("en");
    const out = formatThreadTimestamp("2024-06-01T22:30:00Z");
    expect(/AM|PM/i.test(out)).toBe(false);
  });

  test("does not throw on edge ISO timestamps", async () => {
    await setLang("en");
    expect(() => formatThreadTimestamp("1970-01-01T00:00:00.000Z")).not.toThrow();
  });
});
