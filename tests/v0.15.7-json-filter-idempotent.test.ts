import { describe, it, expect } from "vitest";
import { applyFilter } from "../src/filters.js";

// v0.15.7 — `|json` filter idempotent on already-JSON strings. Phase 6
// finding: applyFilter receives all values as strings (substituteRuntime
// pre-serializes structured values upstream of the filter chain), so
// `|json` on a structured-pre-stringified value was double-encoding —
// turning '{"id":"abc"}' into '"{\\"id\\":\\"abc\\"}"'.
//
// Fix: try JSON.parse first. If parses, pass through (already valid JSON).
// If not, stringify once (the v0.3.x behavior for plain-string inputs).

describe("v0.15.7 — `|json` filter is idempotent on already-JSON strings", () => {
  describe("structured-pre-stringified inputs pass through unchanged", () => {
    it("object-shape JSON string passes through", () => {
      // The bug case: substituteRuntime serializes a structured value into
      // a JSON string, then `|json` should NOT re-stringify it.
      expect(applyFilter('{"id":"abc","count":3}', "json")).toBe('{"id":"abc","count":3}');
    });

    it("array-shape JSON string passes through", () => {
      expect(applyFilter('[1,2,3]', "json")).toBe('[1,2,3]');
    });

    it("nested-object JSON string passes through", () => {
      const nested = '{"outer":{"inner":[1,{"deep":true}]}}';
      expect(applyFilter(nested, "json")).toBe(nested);
    });

    it("empty object JSON string passes through", () => {
      expect(applyFilter("{}", "json")).toBe("{}");
    });

    it("empty array JSON string passes through", () => {
      expect(applyFilter("[]", "json")).toBe("[]");
    });

    it("JSON-string-containing-escaped-quotes passes through", () => {
      const withEscapes = '{"msg":"he said \\"hi\\""}';
      expect(applyFilter(withEscapes, "json")).toBe(withEscapes);
    });
  });

  describe("plain strings get JSON-encoded once", () => {
    it("simple word gets stringified with quotes", () => {
      expect(applyFilter("hello", "json")).toBe('"hello"');
    });

    it("multi-word string gets stringified with escaping if needed", () => {
      expect(applyFilter("hello world", "json")).toBe('"hello world"');
    });

    it("string with internal quotes gets escaped", () => {
      expect(applyFilter('he said "hi"', "json")).toBe('"he said \\"hi\\""');
    });

    it("string with newlines gets escaped", () => {
      expect(applyFilter("line1\nline2", "json")).toBe('"line1\\nline2"');
    });

    it("empty string gets stringified", () => {
      expect(applyFilter("", "json")).toBe('""');
    });
  });

  describe("edge cases — JSON-parseable scalar literals", () => {
    // These previously double-quoted (JSON.stringify("null") → "\"null\"").
    // v0.15.7 pass-through: the rare author who literally meant to JSON-
    // encode the string "null" hits a behavior change; the common author
    // who has a string that happens to read "null" gets sensible idempotence.

    it("literal 'null' passes through (was previously re-quoted)", () => {
      expect(applyFilter("null", "json")).toBe("null");
    });

    it("literal 'true' / 'false' pass through", () => {
      expect(applyFilter("true", "json")).toBe("true");
      expect(applyFilter("false", "json")).toBe("false");
    });

    it("literal numeric strings pass through", () => {
      expect(applyFilter("42", "json")).toBe("42");
      expect(applyFilter("3.14", "json")).toBe("3.14");
      expect(applyFilter("-7", "json")).toBe("-7");
    });

    it("already-quoted string literal passes through", () => {
      // The string '"hello"' is valid JSON (a quoted string literal).
      // Idempotent path: pass through.
      expect(applyFilter('"hello"', "json")).toBe('"hello"');
    });
  });

  describe("regression: existing tests still hold", () => {
    it("non-JSON-shape strings stringify (existing behavior preserved)", () => {
      // Word that isn't valid JSON token → stringified.
      expect(applyFilter("hello world with spaces", "json")).toBe('"hello world with spaces"');
    });

    it("non-JSON-shape string with internal commas stringifies", () => {
      // Looks list-y but no brackets — not valid JSON → stringified.
      expect(applyFilter("a, b, c", "json")).toBe('"a, b, c"');
    });

    it("non-JSON-shape string with internal colons stringifies", () => {
      // Looks object-y but no braces — not valid JSON → stringified.
      expect(applyFilter("key: value", "json")).toBe('"key: value"');
    });
  });
});
