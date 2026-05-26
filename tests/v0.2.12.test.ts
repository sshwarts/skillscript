import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/lint.js";
import { compile } from "../src/compile.js";
import { parse } from "../src/parser.js";
import { bootstrap } from "../src/bootstrap.js";
import { helpResponse } from "../src/help-content.js";
import { execute } from "../src/runtime.js";
import type { BootstrapResult } from "../src/bootstrap.js";

/**
 * v0.2.12 — twelve bug fixes from Perry's wild-and-crazy harness Round 2
 * (memory `a0be74cd`). Bug 15 is the high-severity silently-broken-skill
 * case the harness was designed to find; the others span parser polish,
 * lint coverage extension, mechanical-mode consistency, and docs.
 */

describe("v0.2.12 Bug 15 (HIGH) — blank line in nested else: must not truncate", () => {
  it("Perry's minimum repro: nested if/else after a blank line inside outer else: compiles cleanly", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: RAW=healthy\ngo:\n    if $(RAW) == \"ERR\":\n        ! failed\n    else:\n        ~ prompt=\"x\" model=qwen -> STATUS\n\n        if $(STATUS|trim) == \"healthy\":\n            ! healthy\n        else:\n            ! not healthy\ndefault: go\n";
    const r = await compile(src);
    expect(r.output).toMatch(/healthy/);
    expect(r.output).toMatch(/not healthy/);
  });

  it("blank line between target body and target-level `else:` no longer breaks attach", async () => {
    const src = "# Skill: t\n# Status: Approved\nfoo:\n    ! body\n\nelse:\n    ! handler\ndefault: foo\n";
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
  });
});

describe("v0.2.12 Bug 16 — # Vars: URL values don't fragment on https:", () => {
  it("ENDPOINTS=https://a.com,https://b.com binds as one value", () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: ENDPOINTS=https://a.com,https://b.com, UNITS=metric\nm:\n    ! hi\ndefault: m\n";
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    expect(r.vars).toEqual([
      { name: "ENDPOINTS", default: "https://a.com,https://b.com", required: false },
      { name: "UNITS", default: "metric", required: false },
    ]);
  });
});

describe("v0.2.12 Bug 17 — # Templates: refs are lint-validated", () => {
  let wired: BootstrapResult;
  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "v0212-bug17-"));
    wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await wired.skillStore.store("known-template", "# Skill: known-template\n# Status: Approved\nrun:\n    ! template body\ndefault: run\n");
  });

  it("fires unknown-template-reference for missing template", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Templates: missing-template\n# Output: agent: agent\nm:\n    ! hi\ndefault: m\n";
    const r = await lint(src, { skillStore: wired.skillStore });
    const f = r.findings.find((x) => x.rule === "unknown-template-reference");
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/missing-template/);
  });

  it("clean when template exists", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Templates: known-template\n# Output: agent: agent\nm:\n    ! hi\ndefault: m\n";
    const r = await lint(src, { skillStore: wired.skillStore });
    expect(r.findings.find((x) => x.rule === "unknown-template-reference")).toBeUndefined();
  });
});

describe("v0.2.12 Bug 18 — `>` op limit=$(VAR) substitutes at render", () => {
  it("limit=$(MAX) renders as the resolved value", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: MAX=5\nq:\n    > mode=topical query=\"hi\" limit=$(MAX) -> HITS\ndefault: q\n";
    const r = await compile(src);
    expect(r.output).toMatch(/limit=5/);
    expect(r.output).not.toMatch(/limit=\$\(MAX\)/);
  });
});

describe("v0.2.12 Bug 19 — composition error reports actual op kind", () => {
  let wired: BootstrapResult;
  beforeAll(() => {
    const home = mkdtempSync(join(tmpdir(), "v0212-bug19-"));
    wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  });

  it("error message says `via $ execute_skill` (not `via &`)", async () => {
    const src = "# Skill: t\n# Status: Approved\nm:\n    $ execute_skill skill_name=missing -> OUT\ndefault: m\n";
    const r = await lint(src, { skillStore: wired.skillStore });
    const f = r.findings.find((x) => x.rule === "unknown-skill-reference");
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/via `\$ execute_skill`/);
    expect(f!.message).not.toMatch(/via `&`/);
  });
});

describe("v0.2.12 Bug 20 — runtime_capabilities.runtimeVersion derived from package.json", () => {
  it("RUNTIME_VERSION matches package.json version", async () => {
    const { RUNTIME_VERSION } = await import("../src/version.js");
    const pkg = await import("../package.json", { with: { type: "json" } });
    expect(RUNTIME_VERSION).toBe((pkg.default as { version: string }).version);
  });
});

describe("v0.2.12 Bug 21 — lint-codes help includes unsafe-shell-disabled", () => {
  it("help({topic: 'lint-codes'}) lists unsafe-shell-disabled", () => {
    const r = helpResponse("lint-codes", "0.2.12") as { content: string };
    expect(r.content).toMatch(/unsafe-shell-disabled/);
  });
});

describe("v0.2.12 Bug 22 — # Requires: fallback strips surrounding quotes", () => {
  it("(fallback: \"stranger\") binds WHO = stranger (no quotes)", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Requires: user-var:NAME -> WHO (fallback: \"stranger\")\ng:\n    ! Hello, $(WHO)!\ndefault: g\n";
    const r = await compile(src);
    expect(r.resolvedVariables["WHO"]).toBe("stranger");
    expect(r.output).toMatch(/Hello, stranger!/);
  });
});

describe("v0.2.12 Bug 23 — mechanical-mode `~` op uses Proxy placeholder for field-access", () => {
  let wired: BootstrapResult;
  beforeAll(() => {
    const home = mkdtempSync(join(tmpdir(), "v0212-bug23-"));
    wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  });

  it("$(HI.outputs.text) on a `~`-bound var resolves in mechanical mode", async () => {
    const src = "# Skill: t\n# Status: Approved\nfetch:\n    ~ prompt=\"x\" model=qwen -> HI\nrender: fetch\n    ! Got: $(HI.outputs.text)\ndefault: render\n";
    const r = await compile(src, { skillStore: wired.skillStore });
    const result = await execute(r.parsed, {}, r.targetOrder, { registry: wired.registry, mechanical: true });
    expect(result.errors).toEqual([]);
    expect(result.emissions.some((line) => line.includes("HI.outputs.text"))).toBe(true);
  });
});

describe("v0.2.12 Bug 24 — EVENT.* + ambient family documented in help()", () => {
  it("frontmatter topic lists EVENT.fired_at_unix", () => {
    const r = helpResponse("frontmatter", "0.2.12") as { content: string };
    expect(r.content).toMatch(/EVENT\.fired_at_unix/);
    expect(r.content).toMatch(/EVENT\.fired_at_plus_1d_unix/);
  });

  it("frontmatter topic lists all ambient bare refs", () => {
    const r = helpResponse("frontmatter", "0.2.12") as { content: string };
    for (const ref of ["NOW", "USER", "SESSION_CONTEXT", "TRIGGER_TYPE", "TRIGGER_PAYLOAD", "ERROR_CONTEXT"]) {
      expect(r.content, `missing ambient ref ${ref}`).toMatch(new RegExp(`\\$\\(${ref}\\)`));
    }
  });
});

describe("v0.2.12 Bug 25 — indexed field access documented", () => {
  it("frontmatter topic shows $(LIST.0) form", () => {
    const r = helpResponse("frontmatter", "0.2.12") as { content: string };
    expect(r.content).toMatch(/\$\(LIST\.0\)/);
    expect(r.content).toMatch(/\$\(LIST\.0\.id\)/);
  });
});

describe("v0.2.12 Bug 26 — unknown-retrieval-arg lint", () => {
  it("fires on hallucinated kwarg (`since=`)", async () => {
    const src = "# Skill: t\n# Status: Approved\nq:\n    > mode=topical query=\"x\" limit=5 since=1h -> HITS\ndefault: q\n";
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === "unknown-retrieval-arg");
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/since/);
  });

  it("does NOT fire on documented kwargs alone", async () => {
    const src = "# Skill: t\n# Status: Approved\nq:\n    > mode=topical query=\"x\" limit=5 -> HITS\ndefault: q\n";
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "unknown-retrieval-arg")).toBeUndefined();
  });
});

describe("v0.2.12 — skillfile run alias removed", () => {
  it("usage no longer lists `run`", async () => {
    const { execSync } = await import("node:child_process");
    const out = execSync("node dist/cli.js --help", { encoding: "utf8" });
    expect(out).not.toMatch(/^\s+run\s+/m);
    expect(out).toMatch(/^\s+execute\s+/m);
  });
});
