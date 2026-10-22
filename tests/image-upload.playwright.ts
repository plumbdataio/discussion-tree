import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseDims } from "../broker/image-dims.ts";

// Real-browser checks for "prepare a pasted image for Claude"
// (web/utils/imagePrep.ts): the canvas pipeline cannot run under bun:test.
//   - a 4032x3024 photo pasted into the composer is stored as a 2000px JPEG
//     (what the message points at) with the untouched original kept next to
//     it as <id>.orig.jpg;
//   - EXIF orientation is applied (a sideways-tagged photo comes out portrait);
//   - a small PNG is uploaded byte-for-byte unchanged, with no original;
//   - a HEIC the browser cannot decode is still attached, as .heic, with a
//     notice that Claude cannot read it.
//
// Runs against its own broker (temp DISCUSSION_TREE_HOME + DB, OS-assigned
// port), never a running one:
//   npx playwright test -c playwright.thread.config.ts image-upload

let broker: ChildProcess;
let home: string;
let base: string;
let boardId: string;

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

function startBroker(): Promise<number> {
  home = mkdtempSync(join(tmpdir(), "dt-image-e2e-"));
  broker = spawn("bun", [resolve("broker.ts")], {
    env: {
      ...process.env,
      DISCUSSION_TREE_PORT: "0",
      DISCUSSION_TREE_HOME: home,
      DISCUSSION_TREE_DB: join(home, "db.sqlite"),
      DISCUSSION_TREE_BROKER_URL: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolvePort, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error(`broker did not start: ${buf.slice(-1000)}`)),
      120_000,
    );
    broker.on("exit", (code) =>
      reject(new Error(`broker exited (${code}): ${buf.slice(-1000)}`)),
    );
    broker.stderr!.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolvePort(Number(m[1]));
      }
    });
  });
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const port = await startBroker();
  base = `http://127.0.0.1:${port}`;
  const reg = await post("/register", { pid: process.pid, cwd: home });
  await post("/attach-cc-session", {
    session_id: reg.session_id,
    cc_session_id: "cc-image-e2e",
  });
  const sessions = await (await fetch(base + "/api/sessions")).json();
  const me = sessions.sessions.find((s: any) => s.id === reg.session_id);
  boardId = me.boards.find((b: any) => b.is_default).id;
});

test.afterAll(async () => {
  if (broker && broker.exitCode === null) {
    const exited = new Promise((r) => broker.once("exit", r));
    broker.kill();
    await exited;
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

const COMPOSER = ".default-board-input textarea.answer-input";

type MakeSpec =
  | { kind: "photo"; w: number; h: number; orientation?: number; name: string }
  | { kind: "png"; w: number; h: number; name: string }
  | { kind: "fake-heic"; name: string };

// Build a file IN the page and drop it on the composer (a drop goes through
// the same handler as a paste and is constructible in every engine).
async function dropFile(page: Page, spec: MakeSpec): Promise<number> {
  return page.evaluate(async (spec) => {
    let blob: Blob;
    let type: string;
    if (spec.kind === "fake-heic") {
      // ftyp box with the heic brand, then junk: no browser decodes this.
      const bytes = new Uint8Array(64);
      bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
      blob = new Blob([bytes], { type: "image/heic" });
      type = "image/heic";
    } else {
      const c = document.createElement("canvas");
      c.width = spec.w;
      c.height = spec.h;
      const ctx = c.getContext("2d")!;
      // Photo-like content (gradient + noise) so JPEG sizes are realistic.
      const g = ctx.createLinearGradient(0, 0, spec.w, spec.h);
      g.addColorStop(0, "#3a6");
      g.addColorStop(1, "#c63");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, spec.w, spec.h);
      if (spec.kind === "photo") {
        const img = ctx.getImageData(0, 0, spec.w, spec.h);
        let seed = 1;
        for (let i = 0; i < img.data.length; i += 4) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          const n = (seed % 64) - 32;
          img.data[i] += n;
          img.data[i + 1] += n;
          img.data[i + 2] += n;
        }
        ctx.putImageData(img, 0, 0);
      } else {
        ctx.fillStyle = "#000";
        ctx.font = "48px sans-serif";
        ctx.fillText("screenshot text", 40, 80);
      }
      type = spec.kind === "photo" ? "image/jpeg" : "image/png";
      blob = await new Promise<Blob>((r) =>
        c.toBlob((b) => r(b!), type, 0.92),
      );
      if (spec.kind === "photo" && spec.orientation) {
        // Insert an APP1 Exif segment carrying only the Orientation tag.
        const tiff = [
          0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // MM, IFD at 8
          0x00, 0x01, // 1 entry
          0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, // 0x0112 SHORT x1
          0x00, spec.orientation, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, // next IFD
        ];
        const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
        const len = payload.length + 2;
        const seg = new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
        const orig = new Uint8Array(await blob.arrayBuffer());
        const out = new Uint8Array(orig.length + seg.length);
        out.set(orig.subarray(0, 2), 0);
        out.set(seg, 2);
        out.set(orig.subarray(2), 2 + seg.length);
        blob = new Blob([out], { type });
      }
    }
    const file = new File([blob], spec.name, { type });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ta = document.querySelector(
      ".default-board-input textarea.answer-input",
    )!;
    ta.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
    return file.size;
  }, spec);
}

// Wait for the composer to hold the image block, return the upload url.
async function uploadedUrl(page: Page, nth: number): Promise<string> {
  await expect
    .poll(
      async () =>
        ((await page.locator(COMPOSER).inputValue()).match(
          /!\[image\]\((\/uploads\/[^)]+)\)/g,
        ) ?? []).length,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(nth);
  const all = (await page.locator(COMPOSER).inputValue()).match(
    /!\[image\]\((\/uploads\/[^)]+)\)/g,
  )!;
  return all[nth].slice("![image](".length, -1);
}

function diskPath(url: string): string {
  return join(home, url.replace(/^\//, ""));
}

function origSibling(url: string, ext: string): string {
  return diskPath(url).replace(/\.[a-z]+$/, `.orig.${ext}`);
}

test("pasted images are prepared for Claude", async ({ page }) => {
  test.setTimeout(120_000);
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.accept();
  });
  await page.goto(`${base}/board/${boardId}`);
  await page.locator(COMPOSER).waitFor();

  // 1) 4032x3024 photo -> 2000x1500 JPEG + original kept.
  const photoBytes = await dropFile(page, {
    kind: "photo",
    w: 4032,
    h: 3024,
    name: "IMG_4032.jpg",
  });
  const u1 = await uploadedUrl(page, 0);
  expect(u1).toMatch(/\.jpg$/);
  const d1 = readFileSync(diskPath(u1));
  expect(parseDims(d1)).toEqual({ w: 2000, h: 1500 });
  expect(d1[0]).toBe(0xff);
  expect(d1[1]).toBe(0xd8);
  const o1 = origSibling(u1, "jpg");
  expect(existsSync(o1)).toBe(true);
  expect(statSync(o1).size).toBe(photoBytes);
  console.log(
    `photo 4032x3024: original ${photoBytes} B -> derived ${d1.length} B (2000x1500)`,
  );
  // The composer still names the derived file as the path CC reads.
  const text1 = await page.locator(COMPOSER).inputValue();
  expect(text1).toContain(`](${u1})`);
  expect(text1).not.toContain(".orig.");

  // ?full=1 on a JPEG original redirects to it.
  const full = await fetch(`${base}${u1}?full=1`, { redirect: "manual" });
  expect(full.status).toBe(302);
  expect(full.headers.get("location")).toContain(".orig.jpg");

  // 2) EXIF Orientation=6 (rotate 90) on a landscape-encoded photo ->
  //    portrait derived image.
  await dropFile(page, {
    kind: "photo",
    w: 4032,
    h: 3024,
    orientation: 6,
    name: "IMG_rot.jpg",
  });
  const u2 = await uploadedUrl(page, 1);
  expect(parseDims(readFileSync(diskPath(u2)))).toEqual({ w: 1500, h: 2000 });

  // 3) small PNG -> unchanged, no original.
  const pngBytes = await dropFile(page, {
    kind: "png",
    w: 800,
    h: 600,
    name: "shot.png",
  });
  const u3 = await uploadedUrl(page, 2);
  expect(u3).toMatch(/\.png$/);
  expect(statSync(diskPath(u3)).size).toBe(pngBytes);
  expect(existsSync(origSibling(u3, "png"))).toBe(false);

  // 4) large PNG screenshot -> 2000px PNG.
  await dropFile(page, { kind: "png", w: 3840, h: 2160, name: "big.png" });
  const u4 = await uploadedUrl(page, 3);
  expect(u4).toMatch(/\.png$/);
  expect(parseDims(readFileSync(diskPath(u4)))).toEqual({ w: 2000, h: 1125 });
  expect(existsSync(origSibling(u4, "png"))).toBe(true);

  // 5) undecodable HEIC -> attached as .heic, with a notice.
  await dropFile(page, { kind: "fake-heic", name: "IMG_0001.HEIC" });
  const u5 = await uploadedUrl(page, 4);
  expect(u5).toMatch(/\.heic$/);
  expect(dialogs.length).toBe(1);
  expect(dialogs[0]).toMatch(/HEIC/);
});
