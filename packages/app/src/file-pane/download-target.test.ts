import { describe, expect, it } from "vitest";
import { buildFilePaneDownloadTarget } from "./download-target";

describe("buildFilePaneDownloadTarget", () => {
  it("uses the current filename and resolved workspace path", () => {
    expect(
      buildFilePaneDownloadTarget({
        preview: { path: "docs/readme.md" },
        readTarget: { path: "docs/readme.md" },
        filename: "readme.md",
      }),
    ).toEqual({
      fileName: "readme.md",
      path: "docs/readme.md",
    });
  });

  it("follows the currently displayed file instead of a prior path", () => {
    const first = buildFilePaneDownloadTarget({
      preview: { path: "src/a.ts" },
      readTarget: { path: "src/a.ts" },
      filename: "a.ts",
    });
    const second = buildFilePaneDownloadTarget({
      preview: { path: "src/b.ts" },
      readTarget: { path: "src/b.ts" },
      filename: "b.ts",
    });
    expect(first).toEqual({ fileName: "a.ts", path: "src/a.ts" });
    expect(second).toEqual({ fileName: "b.ts", path: "src/b.ts" });
  });

  it("targets the workspace path rather than editor-buffer contents", () => {
    expect(
      buildFilePaneDownloadTarget({
        preview: { path: "notes.md" },
        readTarget: { path: "notes.md" },
        filename: "notes.md",
      }),
    ).toEqual({
      fileName: "notes.md",
      path: "notes.md",
    });
  });

  it("omits download when the file has not been read", () => {
    expect(
      buildFilePaneDownloadTarget({
        preview: null,
        readTarget: { path: "notes.md" },
        filename: "notes.md",
      }),
    ).toBeNull();
  });

  it("omits download when the workspace path is unresolved", () => {
    expect(
      buildFilePaneDownloadTarget({
        preview: { path: "notes.md" },
        readTarget: null,
        filename: "notes.md",
      }),
    ).toBeNull();
  });
});
