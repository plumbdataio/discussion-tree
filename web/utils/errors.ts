import type { TFunction } from "i18next";

// Broker error responses come in one of two shapes:
//   { error: "errors.<key>", params?: Record<string, unknown> }  ← i18n-coded
//   { error: "free text" }                                       ← legacy / fallback
// translateError prefers the coded form; if `error` doesn't start with
// "errors." we treat it as a literal user-visible string.
export function translateError(
  t: TFunction,
  body: { error?: string; params?: Record<string, unknown> } | null | undefined,
  fallback?: string,
): string {
  if (!body) return fallback ?? t("errors.internal", { message: "" });
  const code = body.error;
  if (!code) return fallback ?? t("errors.internal", { message: "" });
  if (code.startsWith("errors.")) {
    return t(code, (body.params ?? {}) as Record<string, unknown>);
  }
  return code;
}
