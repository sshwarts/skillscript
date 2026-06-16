#!/usr/bin/env node
/**
 * mintlify-escape-mdx-tables.mjs — atom→MDX render-step transform.
 *
 * Mintlify's MDX parser interprets `{...}` as a JSX expression even inside
 * backtick-fenced inline-code, but ONLY when the inline-code sits inside a
 * markdown table cell. Outside tables (plain prose, fenced code blocks)
 * the inline-code containment works correctly.
 *
 * This script narrows the fix to that exact case: within markdown table
 * rows, escape `${` → `$\{` inside inline-code spans. Mintlify renders
 * the escaped form back to literal `${VAR}` on the page; the escape is
 * invisible to readers.
 *
 * Atom source stays unchanged (Perry's call — atoms feed AMP render,
 * help topics, the morning brief, and plain-markdown readers, none of
 * which have the JSX quirk; escaping at source pollutes every consumer
 * to satisfy one render target). The transform belongs to the
 * Mintlify-target render adapter, run on the way out.
 *
 * Usage:
 *   amp_render_document({slug: "skillscript/skillscript-language-reference"})
 *     | extract .markdown
 *     | node scripts/mintlify-escape-mdx-tables.mjs
 *     | tee docs/language-reference.md
 *
 * Or directly: cat raw.md | node scripts/mintlify-escape-mdx-tables.mjs > out.md
 */

import { readFileSync } from "node:fs";

const input = readFileSync(0, "utf8");
const lines = input.split("\n");

let inFence = false;
const output = lines.map((line) => {
  // Fenced code blocks are MDX-safe; pass through untouched + track fence state.
  if (/^\s*```/.test(line)) {
    inFence = !inFence;
    return line;
  }
  if (inFence) return line;

  // Only transform markdown-table-row-shape lines (leading `|`).
  if (!line.trimStart().startsWith("|")) return line;

  // Within table rows, escape `{` inside backtick-fenced inline-code spans.
  // MDX parses any `{...}` as a JSX expression (not just `${...}`); inline-code
  // in markdown tables doesn't shield it. The escape `\{` renders as literal
  // `{` after MDX resolves the escape — visually identical, parser-safe.
  return line.replace(/`([^`]*)`/g, (_match, content) => {
    return "`" + content.replace(/\{/g, "\\{") + "`";
  });
});

process.stdout.write(output.join("\n"));
