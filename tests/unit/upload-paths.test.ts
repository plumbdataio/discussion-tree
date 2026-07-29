import { describe, test, expect } from "bun:test";
import { rewriteUploadPaths } from "../../server/upload-paths.ts";

// A message carries its attachment twice: a URL the browser renders, and an
// absolute path for CC's Read tool — written from the BROKER's filesystem. On
// the same machine that is exactly right. From another machine the path does
// not exist, so handing it over unchanged means CC opens nothing; it becomes a
// get_image call, which fetches the bytes from the broker instead.

const MSG =
  "look at this\n" +
  "![image](/uploads/bd_x/img_1.png)\n" +
  "[image] [/Users/pekehata/.discussion-tree/uploads/bd_x/img_1.png](/uploads/bd_x/img_1.png)";

describe("upload paths — seeing an attachment from another machine", () => {
  test("a local session's text is untouched", () => {
    // Its Read tool can open the real file; anything else would be a detour
    // through the broker for a file already on disk.
    expect(rewriteUploadPaths(MSG, false)).toBe(MSG);
  });

  test("a remote session gets the call that works instead of the path", () => {
    const out = rewriteUploadPaths(MSG, true);
    expect(out).toContain('get_image("/uploads/bd_x/img_1.png")');
    expect(out).not.toContain("/Users/pekehata/.discussion-tree/uploads");
    // The markdown URL is what the BROWSER fetches and is already correct from
    // anywhere the broker is reachable — rewriting it would break the image.
    expect(out).toContain("![image](/uploads/bd_x/img_1.png)");
  });

  test("a Windows-style path is recognised too", () => {
    const win =
      "[image] [C:\\Users\\mtaka\\.discussion-tree\\uploads\\bd_x\\img_1.png](/uploads/bd_x/img_1.png)";
    expect(rewriteUploadPaths(win, true)).toContain("get_image(");
  });

  test("text with no attachment is returned unchanged", () => {
    const plain = "just words about .discussion-tree, no path";
    expect(rewriteUploadPaths(plain, true)).toBe(plain);
  });

  test("rewriting twice changes nothing further", () => {
    const once = rewriteUploadPaths(MSG, true);
    expect(rewriteUploadPaths(once, true)).toBe(once);
  });
});
