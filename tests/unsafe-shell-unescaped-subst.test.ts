import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

// Sub-charter 3d: closes audit finding #5. Sibling to existing
// `unsafe-shell-ambiguous-subst` rule (which fires on undeclared refs
// that could collide with bash `$(cmd)` syntax). This rule fires on the
// opposite case: declared refs interpolated raw into bash without the
// `|shell` escape filter. Variable values containing whitespace or shell
// metacharacters break the command silently or become injectable.

describe("unsafe-shell-unescaped-subst (audit finding #5)", () => {
  it("fires on `${VAR}` in shell(unsafe=true) body without |shell filter", async () => {
    const src = `# Skill: t
# Vars: USERNAME=alice
t:
    shell(command="echo Hello \${USERNAME}", unsafe=true)
default: t
`;
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === "unsafe-shell-unescaped-subst");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.extras?.["var_name"]).toBe("USERNAME");
  });

  it("does NOT fire when |shell filter is applied", async () => {
    const src = `# Skill: t
# Vars: USERNAME=alice
t:
    shell(command="echo Hello \${USERNAME|shell}", unsafe=true)
default: t
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "unsafe-shell-unescaped-subst")).toBeUndefined();
  });

  it("does NOT fire on `shell()` (safe mode, no unsafe=true) — structural spawn doesn't need bash escape", async () => {
    const src = `# Skill: t
# Vars: USERNAME=alice
t:
    shell(command="echo Hello \${USERNAME}")
default: t
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "unsafe-shell-unescaped-subst")).toBeUndefined();
  });

  it("does NOT fire on dotted refs (structured access — author's responsibility)", async () => {
    const src = `# Skill: t
t:
    shell(command="echo \${EVENT.fired_at_unix}", unsafe=true)
default: t
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "unsafe-shell-unescaped-subst")).toBeUndefined();
  });

  it("does NOT fire on ambient refs (NOW, USER) — author can't filter them at declaration site", async () => {
    const src = `# Skill: t
t:
    shell(command="echo \${NOW}", unsafe=true)
default: t
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "unsafe-shell-unescaped-subst")).toBeUndefined();
  });

  it("does NOT fire on undeclared refs (undeclared-var or ambiguous-subst handles them)", async () => {
    const src = `# Skill: t
t:
    shell(command="echo \${UNDECLARED}", unsafe=true)
default: t
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "unsafe-shell-unescaped-subst")).toBeUndefined();
  });

  it("fires on legacy paren-form `$(VAR)` too", async () => {
    const src = `# Skill: t
# Vars: NAME=bob
t:
    shell(command="echo Hi $(NAME)", unsafe=true)
default: t
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "unsafe-shell-unescaped-subst")).toBeDefined();
  });

  it("dedupes per variable per target (single fire per VAR even with N occurrences)", async () => {
    const src = `# Skill: t
# Vars: ARG=x
t:
    shell(command="echo \${ARG} \${ARG} \${ARG}", unsafe=true)
default: t
`;
    const r = await lint(src);
    const fs = r.findings.filter((x) => x.rule === "unsafe-shell-unescaped-subst");
    expect(fs).toHaveLength(1);
  });

  it("does NOT fire on `$$(...)` bash-literal escape (single-$ refs only)", async () => {
    const src = `# Skill: t
# Vars: HOST=example.com
t:
    shell(command="curl https://$$(uname -n)/\${HOST|shell}", unsafe=true)
default: t
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "unsafe-shell-unescaped-subst")).toBeUndefined();
  });

  it("message includes the `|shell` remediation hint", async () => {
    const src = `# Skill: t
# Vars: Q=x
t:
    shell(command="grep \${Q} file.txt", unsafe=true)
default: t
`;
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === "unsafe-shell-unescaped-subst");
    expect(f!.message).toMatch(/\$\{Q\|shell\}/);
  });
});
