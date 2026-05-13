import "./happydom.ts";
import { describe, test, expect } from "bun:test";
import { translateError } from "../../web/utils/errors.ts";

// Minimal fake TFunction. Records the most recent call so we can assert what
// the translator was asked to do.
type Call = { key: string; params: Record<string, unknown> };
function makeT() {
  const calls: Call[] = [];
  const t = ((key: string, params?: Record<string, unknown>) => {
    calls.push({ key, params: params ?? {} });
    if (key === "errors.internal") return `internal:${params?.message ?? ""}`;
    if (key === "errors.no_recipient") return "no recipient";
    if (key === "errors.delivery_timeout") return "delivery timed out";
    if (key === "errors.with_params")
      return `with_params:${params?.foo ?? ""}`;
    return `<${key}>`;
  }) as any;
  return { t, calls };
}

describe("translateError", () => {
  test("returns the i18n-coded translation for an errors.* key", () => {
    const { t } = makeT();
    expect(translateError(t, { error: "errors.no_recipient" })).toBe(
      "no recipient",
    );
  });

  test("forwards params to the translator", () => {
    const { t, calls } = makeT();
    const out = translateError(t, {
      error: "errors.with_params",
      params: { foo: "bar" },
    });
    expect(out).toBe("with_params:bar");
    expect(calls[calls.length - 1].params).toEqual({ foo: "bar" });
  });

  test("returns the raw string when error does not start with errors.", () => {
    const { t } = makeT();
    expect(translateError(t, { error: "Boom" })).toBe("Boom");
  });

  test("returns fallback when body is null", () => {
    const { t } = makeT();
    expect(translateError(t, null, "fallback!")).toBe("fallback!");
  });

  test("returns fallback when body is undefined", () => {
    const { t } = makeT();
    expect(translateError(t, undefined, "fallback!")).toBe("fallback!");
  });

  test("falls through to errors.internal when no fallback and no body", () => {
    const { t } = makeT();
    expect(translateError(t, null)).toBe("internal:");
  });

  test("returns fallback when body has no error field", () => {
    const { t } = makeT();
    expect(translateError(t, {} as any, "fb")).toBe("fb");
  });

  test("treats empty params as {} for the translator", () => {
    const { t, calls } = makeT();
    translateError(t, { error: "errors.no_recipient" });
    expect(calls[calls.length - 1].params).toEqual({});
  });
});
