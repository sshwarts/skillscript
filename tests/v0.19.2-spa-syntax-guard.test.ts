import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

/**
 * v0.19.2 — guard against TS-style syntax creeping into the plain-JS
 * dashboard SPA. v0.18.9 shipped `app.js` with `arr[idx]!` non-null
 * assertions copy-pasted from TS source; browser hit SyntaxError on
 * load → entire SPA script never executed → menu rendered (static
 * HTML) but contents stayed blank. Type-check + unit tests passed (TS
 * compiler accepts the syntax; tests don't load app.js in a JS
 * runtime). The bug only surfaced at adopter runtime.
 *
 * `node --check` parses the file under V8's normal-JS rules — same
 * rules the browser applies. Catches the syntax mismatch at test
 * time so the SPA never ships unparseable.
 *
 * Future SPA additions in `src/dashboard/spa/*.js` extend this test
 * if more files land. Today: just app.js (the only SPA module).
 */
describe("v0.19.2 — SPA app.js parses as plain JS (browser-runnable)", () => {
  it("src/dashboard/spa/app.js is syntactically valid plain JavaScript", () => {
    const appJsPath = join(REPO_ROOT, "src/dashboard/spa/app.js");
    // node --check parses the file and exits non-zero on syntax errors.
    // Throws if invalid; passes cleanly if valid.
    expect(() => execSync(`node --check "${appJsPath}"`, { stdio: "pipe" })).not.toThrow();
  });

  it("app.js contains no TS-style non-null assertions (`arr[idx]!`)", () => {
    // Belt-and-suspenders explicit check beyond node --check, because
    // some TS syntax (e.g., `as Type`) is silently accepted as a
    // valid no-op in JS expression position. The `!.` and `]!` shapes
    // are the ones that surface as SyntaxError. Explicit grep guards
    // the specific class.
    const { readFileSync } = require("node:fs");
    const source = readFileSync(join(REPO_ROOT, "src/dashboard/spa/app.js"), "utf8") as string;
    // Match `]!` or `!.` outside of string/comment context. Light
    // regex; false positives acceptable (string-literal "!" embedded
    // in user-facing text is a pattern worth flagging anyway).
    expect(source).not.toMatch(/\]!\s*\./);
    expect(source).not.toMatch(/\]!\s*\(/);
    expect(source).not.toMatch(/\)!\s*\./);
  });
});
