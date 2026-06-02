import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { lint } from "../src/lint.js";

/**
 * v0.4.2 item 2 — `# Autonomous: true` header + unconfirmed-mutation
 * conditional suppression. Spec: Perry approval `efad035f`. The header
 * is a category marker (Perry's framing), not a single-suppression hook
 * — implementation lives on ParsedSkill.autonomous so future rules /
 * scheduling defaults / discovery surfaces can consult the same field.
 */

describe("v0.4.2 — # Autonomous header parser recognition", () => {
  it("# Autonomous: true sets parsed.autonomous === true", () => {
    const src = `# Skill: t\n# Status: Approved\n# Autonomous: true\nrun:\n    emit(text="hi")\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    expect(r.autonomous).toBe(true);
  });

  it("# Autonomous: false sets parsed.autonomous === false", () => {
    const src = `# Skill: t\n# Status: Approved\n# Autonomous: false\nrun:\n    emit(text="hi")\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    expect(r.autonomous).toBe(false);
  });

  it("absent header → parsed.autonomous === null (lint treats as default-interactive)", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="hi")\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    expect(r.autonomous).toBeNull();
  });

  it("invalid value → parse error", () => {
    const src = `# Skill: t\n# Status: Approved\n# Autonomous: yes\nrun:\n    emit(text="hi")\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors[0]).toMatch(/`# Autonomous:` value must be 'true' or 'false'/);
  });
});

describe("v0.4.2 — unconfirmed-mutation conditional on Autonomous", () => {
  const mutationSkill = (autonomous: string | null) => {
    const header = autonomous === null ? "" : `# Autonomous: ${autonomous}\n`;
    return `# Skill: t\n# Status: Approved\n${header}run:\n    $ datastore.write_thing key=value\n    emit(text="done")\ndefault: run\n`;
  };

  it("absent header → unconfirmed-mutation fires (existing v0.2.11+ behavior)", async () => {
    const r = await lint(mutationSkill(null));
    const finding = r.findings.find((f) => f.rule === "unconfirmed-mutation");
    expect(finding).toBeDefined();
    expect(finding!.message).toMatch(/write_thing/);
  });

  it("# Autonomous: true → unconfirmed-mutation silent (v0.4.2)", async () => {
    const r = await lint(mutationSkill("true"));
    const finding = r.findings.find((f) => f.rule === "unconfirmed-mutation");
    expect(finding).toBeUndefined();
  });

  it("# Autonomous: false → unconfirmed-mutation still fires", async () => {
    const r = await lint(mutationSkill("false"));
    const finding = r.findings.find((f) => f.rule === "unconfirmed-mutation");
    expect(finding).toBeDefined();
  });

  it("# Autonomous: true + bare mutation → still silent (header dominates)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Autonomous: true\nrun:\n    $ datastore.write_thing key=value\ndefault: run\n`;
    const r = await lint(src);
    const finding = r.findings.find((f) => f.rule === "unconfirmed-mutation");
    expect(finding).toBeUndefined();
  });
});

describe("v0.4.2 — Autonomous header in help-content", () => {
  it("frontmatter topic documents the # Autonomous header", async () => {
    const { helpResponse } = await import("../src/help-content.js");
    const r = helpResponse("frontmatter", "0.4.2") as { content: string };
    expect(r.content).toMatch(/# Autonomous: true \| false/);
    expect(r.content).toMatch(/declarative authorship intent/);
  });

  it("lint-codes topic notes the Autonomous exemption on unconfirmed-mutation", async () => {
    const { helpResponse } = await import("../src/help-content.js");
    const r = helpResponse("lint-codes", "0.4.2") as { content: string };
    expect(r.content).toMatch(/unconfirmed-mutation/);
    expect(r.content).toMatch(/`# Autonomous: true`/);
  });
});
