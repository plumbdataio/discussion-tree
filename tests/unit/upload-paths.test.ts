import { describe, test, expect } from "bun:test";
import { rewriteUploadPaths } from "../../server/upload-paths.ts";

// A CC on another machine is told to Read a path that only exists on the
// broker's filesystem. If that directory is mounted here under another name,
// the path is rewritten before CC ever sees it — rewriting rather than
// documenting, because a convention only holds while everyone remembers it and
// the failure is silent (CC says it cannot read the file, or answers without
// having looked).

const MSG =
  "look at this\n" +
  "![image](/uploads/bd_x/img_1.png)\n" +
  "[image] [/Users/pekehata/.discussion-tree/uploads/bd_x/img_1.png](/uploads/bd_x/img_1.png)";

describe("upload paths — reading an attachment from another machine", () => {
  test("with no mount configured, nothing is touched", () => {
    expect(rewriteUploadPaths(MSG, undefined)).toBe(MSG);
    expect(rewriteUploadPaths(MSG, "   ")).toBe(MSG);
  });

  test("the absolute path is repointed, the served URL is not", () => {
    const out = rewriteUploadPaths(MSG, "/mnt/dt-uploads");
    expect(out).toContain("/mnt/dt-uploads/bd_x/img_1.png");
    expect(out).not.toContain("/Users/pekehata/.discussion-tree/uploads");
    // The markdown URL is what the BROWSER fetches and is already correct from
    // anywhere the broker is reachable — rewriting it would break the image.
    expect(out).toContain("![image](/uploads/bd_x/img_1.png)");
  });

  test("a Windows mount produces Windows paths", () => {
    // The Read tool on that machine wants backslashes, and the drive letter is
    // the whole point of the exercise.
    const out = rewriteUploadPaths(MSG, "Z:\\dt-uploads\\");
    expect(out).toContain("Z:\\dt-uploads\\bd_x/img_1.png");
  });

  test("a path already on this machine's share is rewritten idempotently", () => {
    const once = rewriteUploadPaths(MSG, "/mnt/u");
    expect(rewriteUploadPaths(once, "/mnt/u")).toBe(once);
  });

  test("text with no attachment is returned unchanged", () => {
    const plain = "just words about .discussion-tree, no path";
    expect(rewriteUploadPaths(plain, "/mnt/u")).toBe(plain);
  });
});
