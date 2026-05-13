import "./happydom.ts";
import { test, expect } from "bun:test";

test("happy-dom globals are present", () => {
  expect(typeof window).toBe("object");
  expect(typeof document).toBe("object");
  expect(typeof localStorage).toBe("object");
  localStorage.setItem("k", "v");
  expect(localStorage.getItem("k")).toBe("v");
  localStorage.clear();
});
