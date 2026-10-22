import { describe, test, expect } from "bun:test";
import {
  CLAUDE_MAX_EDGE,
  derivedFilename,
  fitLongEdge,
  fullSizeHref,
  looksLikeImage,
  planPrep,
  sourceKind,
} from "../../web/utils/imagePrep.ts";

// The pure decisions behind "prepare a pasted image for Claude" (the canvas
// pipeline itself needs a real browser and is covered by the Playwright check).

describe("fitLongEdge", () => {
  test("cap is 2000px", () => {
    expect(CLAUDE_MAX_EDGE).toBe(2000);
  });

  test("landscape iPhone photo -> 2000 x 1500", () => {
    expect(fitLongEdge(4032, 3024)).toEqual({ w: 2000, h: 1500, scaled: true });
  });

  test("portrait keeps the long edge on height", () => {
    expect(fitLongEdge(3024, 4032)).toEqual({ w: 1500, h: 2000, scaled: true });
  });

  test("aspect ratio is preserved within rounding", () => {
    const r = fitLongEdge(5000, 1234);
    expect(r.w).toBe(2000);
    expect(r.h).toBe(Math.round(1234 * (2000 / 5000)));
  });

  test("square", () => {
    expect(fitLongEdge(2500, 2500)).toEqual({ w: 2000, h: 2000, scaled: true });
  });

  test("never upscales; exactly 2000 is left alone", () => {
    expect(fitLongEdge(800, 600)).toEqual({ w: 800, h: 600, scaled: false });
    expect(fitLongEdge(2000, 1000)).toEqual({ w: 2000, h: 1000, scaled: false });
  });

  test("an extreme panorama keeps the short side at least 1px", () => {
    const r = fitLongEdge(100000, 1);
    expect(r).toEqual({ w: 2000, h: 1, scaled: true });
  });

  test("the long edge never lands on max+1 from rounding", () => {
    for (const [w, h] of [
      [2001, 2000],
      [3999, 2667],
      [2667, 3999],
    ]) {
      const r = fitLongEdge(w, h);
      expect(Math.max(r.w, r.h)).toBe(2000);
    }
  });
});

describe("sourceKind / looksLikeImage", () => {
  test("by MIME", () => {
    expect(sourceKind("image/jpeg", "")).toBe("jpeg");
    expect(sourceKind("image/png", "")).toBe("png");
    expect(sourceKind("image/gif", "")).toBe("gif");
    expect(sourceKind("image/webp", "")).toBe("webp");
    expect(sourceKind("image/heic", "")).toBe("heic");
    expect(sourceKind("image/heif", "")).toBe("heic");
    expect(sourceKind("image/heic-sequence", "")).toBe("heic");
  });

  test("HEIC with an empty MIME is recognised by extension", () => {
    expect(sourceKind("", "IMG_0001.HEIC")).toBe("heic");
    expect(sourceKind("", "photo.heif")).toBe("heic");
    expect(looksLikeImage("", "IMG_0001.HEIC")).toBe(true);
  });

  test("non-images stay non-images", () => {
    expect(sourceKind("application/pdf", "a.pdf")).toBe("other");
    expect(looksLikeImage("application/pdf", "a.pdf")).toBe(false);
    expect(looksLikeImage("", "notes.txt")).toBe(false);
  });

  test("an unknown image/* type is still an image (uploaded unchanged)", () => {
    expect(looksLikeImage("image/avif", "x.avif")).toBe(true);
    expect(sourceKind("image/avif", "x.avif")).toBe("other");
  });
});

describe("planPrep", () => {
  test("a small JPEG / PNG / WebP is uploaded unchanged (no recompression)", () => {
    expect(planPrep("jpeg", 1200, 900)).toEqual({ action: "keep" });
    expect(planPrep("png", 1920, 1080)).toEqual({ action: "keep" });
    expect(planPrep("webp", 2000, 2000)).toEqual({ action: "keep" });
  });

  test("a large JPEG becomes a 2000px JPEG", () => {
    expect(planPrep("jpeg", 4032, 3024)).toEqual({
      action: "convert",
      w: 2000,
      h: 1500,
      format: "jpeg",
    });
  });

  test("a large WebP is treated as a photo -> JPEG", () => {
    expect(planPrep("webp", 3000, 3000)).toMatchObject({ format: "jpeg" });
  });

  test("a large PNG (screenshot) stays PNG", () => {
    expect(planPrep("png", 5120, 2880)).toEqual({
      action: "convert",
      w: 2000,
      h: 1125,
      format: "png",
    });
  });

  test("HEIC is always converted to JPEG, even when small", () => {
    expect(planPrep("heic", 800, 600)).toEqual({
      action: "convert",
      w: 800,
      h: 600,
      format: "jpeg",
    });
    expect(planPrep("heic", 4032, 3024)).toEqual({
      action: "convert",
      w: 2000,
      h: 1500,
      format: "jpeg",
    });
  });

  test("GIF is never re-encoded (it would lose its animation)", () => {
    expect(planPrep("gif", 4000, 3000)).toEqual({ action: "keep" });
  });

  test("unknown kinds are left alone", () => {
    expect(planPrep("other", 6000, 4000)).toEqual({ action: "keep" });
  });
});

describe("derivedFilename", () => {
  test("swaps the extension for the output format", () => {
    expect(derivedFilename("IMG_0001.HEIC", "image/jpeg")).toBe("IMG_0001.jpg");
    expect(derivedFilename("shot.png", "image/png")).toBe("shot.png");
    expect(derivedFilename("shot.png", "image/webp")).toBe("shot.webp");
  });

  test("no name / no extension", () => {
    expect(derivedFilename("", "image/jpeg")).toBe("pasted.jpg");
    expect(derivedFilename("image", "image/png")).toBe("image.png");
  });
});

describe("fullSizeHref", () => {
  test("uploads get ?full=1", () => {
    expect(fullSizeHref("/uploads/bd_x/img_a.jpg")).toBe(
      "/uploads/bd_x/img_a.jpg?full=1",
    );
  });

  test("external URLs and URLs with a query are untouched", () => {
    expect(fullSizeHref("https://example.com/a.png")).toBe(
      "https://example.com/a.png",
    );
    expect(fullSizeHref("/uploads/bd_x/img_a.jpg?v=2")).toBe(
      "/uploads/bd_x/img_a.jpg?v=2",
    );
  });
});
