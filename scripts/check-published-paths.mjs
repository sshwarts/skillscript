#!/usr/bin/env node
/**
 * Build-time guard: verify every relative markdown link in README.md resolves
 * to a path that ships in the npm tarball.
 *
 * Closes the regression class that bit v0.13.2 dogfood — README linked to
 * docs/configuration.md, docs/adopter-playbook.md, etc., but docs/ wasn't in
 * package.json `files`. Adopter following the README hit dead links
 * immediately. Five ship cycles undetected (no test asserted tarball contents
 * vs README references).
 *
 * Runs in every `pnpm run build` — local + CI release.yml + dogfood-t7 (which
 * exec's `pnpm pack` which runs build).
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Markdown files whose relative links we verify. Only files that themselves
// ship in the tarball — otherwise broken links in unshipped files are noise.
const SOURCES = ["README.md"];

function shipSet() {
  const out = execSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const reports = JSON.parse(out);
  if (!Array.isArray(reports) || reports.length === 0 || !reports[0].files) {
    throw new Error("npm pack --dry-run returned unexpected shape; cannot verify");
  }
  return new Set(reports[0].files.map((f) => f.path));
}

function extractRelativeLinks(markdown) {
  // Strip fenced code blocks so example links inside ``` don't get flagged.
  const stripped = markdown.replace(/```[\s\S]*?```/g, "");
  const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  const links = [];
  let m;
  while ((m = linkRe.exec(stripped)) !== null) {
    const url = m[2].trim();
    if (
      url.startsWith("http://") ||
      url.startsWith("https://") ||
      url.startsWith("mailto:") ||
      url.startsWith("#")
    ) {
      continue;
    }
    // Strip anchor fragment ("docs/foo.md#section" → "docs/foo.md").
    // We verify the file ships; we don't validate the anchor target.
    const path = url.split("#")[0];
    if (path === "") continue;
    links.push({ text: m[1], url, path });
  }
  return links;
}

function main() {
  const ship = shipSet();
  const report = [];
  let totalBroken = 0;

  // A link resolves if either:
  //  - it names a file that ships exactly (e.g. "docs/configuration.md")
  //  - it names a directory under which at least one file ships
  //    (e.g. "examples/" or "examples" → any ship path starts with "examples/")
  const shipArray = Array.from(ship);
  // `npm pack` reports POSIX paths on every platform; markdown links are
  // authored in POSIX form. Use `posix.normalize` so Windows runners don't
  // produce backslash-normalized strings that fail the set lookup.
  const resolves = (linkPath) => {
    const normalized = posix.normalize(linkPath);
    if (ship.has(normalized)) return true;
    const dirPrefix = normalized.endsWith("/") ? normalized : normalized + "/";
    return shipArray.some((p) => p.startsWith(dirPrefix));
  };

  for (const source of SOURCES) {
    const sourcePath = join(REPO_ROOT, source);
    const body = readFileSync(sourcePath, "utf8");
    const broken = extractRelativeLinks(body).filter((link) => !resolves(link.path));
    if (broken.length > 0) {
      report.push(`  ${source} — ${broken.length} broken relative link(s):`);
      for (const b of broken) {
        report.push(`    "${b.text}" → ${b.url}`);
      }
      totalBroken += broken.length;
    }
  }

  if (totalBroken === 0) {
    console.log(
      `OK: all relative markdown links in ${SOURCES.join(", ")} resolve to paths in the published tarball.`,
    );
    process.exit(0);
  }

  console.error(
    "FAIL: relative markdown link(s) point at paths NOT in the npm tarball.",
  );
  console.error("");
  console.error(report.join("\n"));
  console.error("");
  console.error("Fix options:");
  console.error("  1. Add the missing paths to package.json `files` array.");
  console.error("  2. Rewrite the links to absolute GitHub URLs pinned to a release tag.");
  console.error("  3. Remove the broken links from the source markdown.");
  process.exit(1);
}

main();
