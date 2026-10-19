import "./happydom.ts";
import { describe, test, expect, beforeEach } from "bun:test";
import {
  DEFAULT_MIN_WIDTH,
  VIEWPORT_MARGIN,
  clampWidth,
  loadWidth,
  saveWidth,
  widthAfterDrag,
} from "../../web/utils/resizableWidth.ts";

describe("clampWidth", () => {
  test("keeps a width that is inside the bounds", () => {
    expect(clampWidth(900, 1440)).toBe(900);
  });

  test("raises a too-narrow width to the minimum", () => {
    expect(clampWidth(100, 1440)).toBe(DEFAULT_MIN_WIDTH);
    expect(clampWidth(100, 1440, 300)).toBe(300);
  });

  test("caps at the viewport minus the margin", () => {
    expect(clampWidth(5000, 1440)).toBe(1440 - VIEWPORT_MARGIN);
    expect(clampWidth(5000, 1000, 420, 20)).toBe(980);
  });

  test("the viewport bound wins when the viewport is narrower than the minimum", () => {
    expect(clampWidth(600, 400)).toBe(400 - VIEWPORT_MARGIN);
  });

  test("re-clamping a stored width to a smaller window shrinks it", () => {
    const stored = 1300;
    expect(clampWidth(stored, 1440)).toBe(1300);
    expect(clampWidth(stored, 1000)).toBe(1000 - VIEWPORT_MARGIN);
  });

  test("non-finite input falls back to the max, never NaN", () => {
    expect(clampWidth(NaN, 1440)).toBe(1440 - VIEWPORT_MARGIN);
  });

  test("rounds to whole pixels", () => {
    expect(clampWidth(700.6, 1440)).toBe(701);
  });
});

describe("widthAfterDrag (centered element: both edges move)", () => {
  test("dragging the right edge outward widens by twice the distance", () => {
    expect(widthAfterDrag(800, 50, "right")).toBe(900);
    expect(widthAfterDrag(800, -50, "right")).toBe(700);
  });

  test("dragging the left edge outward (leftward) widens", () => {
    expect(widthAfterDrag(800, -50, "left")).toBe(900);
    expect(widthAfterDrag(800, 50, "left")).toBe(700);
  });
});

describe("loadWidth / saveWidth", () => {
  const KEY = "test-resizable-width";
  beforeEach(() => localStorage.removeItem(KEY));

  test("nothing stored -> null", () => {
    expect(loadWidth(KEY)).toBeNull();
  });

  test("round-trips a saved width", () => {
    saveWidth(KEY, 1123.4);
    expect(localStorage.getItem(KEY)).toBe("1123");
    expect(loadWidth(KEY)).toBe(1123);
  });

  test("saving null removes the entry (reset to default)", () => {
    saveWidth(KEY, 900);
    saveWidth(KEY, null);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(loadWidth(KEY)).toBeNull();
  });

  test("garbage or non-positive values read as null", () => {
    localStorage.setItem(KEY, "wide");
    expect(loadWidth(KEY)).toBeNull();
    localStorage.setItem(KEY, "0");
    expect(loadWidth(KEY)).toBeNull();
    localStorage.setItem(KEY, "-5");
    expect(loadWidth(KEY)).toBeNull();
  });

  test("blocked storage does not throw", () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(loadWidth(KEY)).toBeNull();
      expect(() => saveWidth(KEY, 900)).not.toThrow();
      expect(() => saveWidth(KEY, null)).not.toThrow();
    } finally {
      if (orig) Object.defineProperty(globalThis, "localStorage", orig);
    }
  });
});
