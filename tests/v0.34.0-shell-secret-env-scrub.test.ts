/**
 * v0.34.0 — `shell(...)` children are spawned with `SKILLSCRIPT_SECRET_*`
 * scrubbed from their env, on BOTH the structured (`command=`/`argv=`) and the
 * `unsafe=true` (`bash -c`) paths.
 *
 * Scott ruled scrub-not-document (Perry signoff `0ab37427`). The runtime
 * resolves `{{secret.NAME}}` itself and splices the value into the spawn argv at
 * the sink, so a shell child never legitimately needs the raw secret var in its
 * ambient env — reading it there is an *undeclared* ambient read, the exact
 * thing `# Requires` exists to gate. Scrubbing the prefix makes `# Requires`
 * least-privilege AUTHORITATIVE. The scrub is secret-vars-only: egress vars
 * (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, …) do NOT carry the prefix, so they
 * still inherit and the outbound-proxy egress pattern is unaffected.
 *
 * Observable: run `env` through a shell op and inspect the captured stdout —
 * the secret key must be absent, a non-secret canary must survive.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";
import { EnvSecretProvider } from "../src/secrets.js";

const SECRET_KEY = "SKILLSCRIPT_SECRET_SCRUBCANARY";
const SECRET_VALUE = "leaked-secret-should-not-appear-ZZZ";
const EGRESS_KEY = "HTTPS_PROXY";
const EGRESS_VALUE = "http://proxy.invalid:3128";
const NEUTRAL_KEY = "SCRUB_TEST_NEUTRAL_CANARY";
const NEUTRAL_VALUE = "preserved-neutral";

/** Set the ambient env for the runtime process, run `fn`, then restore. */
async function withAmbientEnv(
  vars: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function runShellEnv(body: string, ctxExtra: Record<string, unknown>): Promise<string> {
  const src = `# Skill: env-probe
# Vars: (none)

default: run
run:
    ${body} -> OUT
`;
  const parsed = parse(src);
  expect(parsed.parseErrors).toEqual([]);
  const r = await execute(parsed, {}, ["run"], {
    agentId: "test-agent",
    registry: new Registry(),
    effectsAuthorized: true,
    ...ctxExtra,
  });
  expect(r.errors).toEqual([]);
  return String(r.finalVars["OUT"] ?? "");
}

describe("v0.34.0 — shell child env scrub (structured path)", () => {
  it("removes SKILLSCRIPT_SECRET_* but preserves egress + other vars", async () => {
    await withAmbientEnv(
      {
        [SECRET_KEY]: SECRET_VALUE,
        [EGRESS_KEY]: EGRESS_VALUE,
        [NEUTRAL_KEY]: NEUTRAL_VALUE,
      },
      async () => {
        const out = await runShellEnv('shell(command="env")', {
          shellAllowlist: ["env"],
        });
        // The secret is gone — neither its key nor its value reaches the child.
        expect(out).not.toContain(SECRET_KEY);
        expect(out).not.toContain(SECRET_VALUE);
        // Egress vars + arbitrary non-secret vars still inherit (proxy pattern intact).
        expect(out).toContain(`${EGRESS_KEY}=${EGRESS_VALUE}`);
        expect(out).toContain(`${NEUTRAL_KEY}=${NEUTRAL_VALUE}`);
      },
    );
  });
});

describe("v0.34.0 — shell child env scrub (unsafe=true / bash -c path)", () => {
  it("removes SKILLSCRIPT_SECRET_* but preserves egress + other vars", async () => {
    await withAmbientEnv(
      {
        [SECRET_KEY]: SECRET_VALUE,
        [EGRESS_KEY]: EGRESS_VALUE,
        [NEUTRAL_KEY]: NEUTRAL_VALUE,
      },
      async () => {
        const out = await runShellEnv('shell(command="env", unsafe=true)', {
          shellAllowlist: ["bash"],
          enableUnsafeShell: true,
        });
        expect(out).not.toContain(SECRET_KEY);
        expect(out).not.toContain(SECRET_VALUE);
        expect(out).toContain(`${EGRESS_KEY}=${EGRESS_VALUE}`);
        expect(out).toContain(`${NEUTRAL_KEY}=${NEUTRAL_VALUE}`);
      },
    );
  });
});

describe("v0.34.0 — scrub does not break a DECLARED secret", () => {
  it("a `{{secret.NAME}}` marker still resolves at the sink even with the ambient var scrubbed", async () => {
    // The value is provisioned in the provider (the supported path) AND sits in
    // the ambient env (which the child no longer sees). The declared marker is
    // spliced into argv, so it delivers the value regardless of the scrub —
    // proving the scrub removes only the UNDECLARED ambient-read path.
    const SHELL_SKILL = [
      "# Skill: declared-secret",
      "# Requires: secret.TOKEN",
      "# Status: Draft",
      "",
      "default: run",
      "run:",
      '    shell(command="printf %s {{secret.TOKEN}}") -> OUT',
    ].join("\n");
    await withAmbientEnv({ SKILLSCRIPT_SECRET_TOKEN: "ambient-copy" }, async () => {
      const compiled = await compile(SHELL_SKILL);
      const r = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
        agentId: "test-agent",
        registry: new Registry(),
        effectsAuthorized: true,
        shellAllowlist: ["printf"],
        secretProvider: new EnvSecretProvider({ SKILLSCRIPT_SECRET_TOKEN: "provider-value" }),
      });
      expect(r.errors).toEqual([]);
      // Delivered from the provider via the marker splice, not the ambient env.
      expect(r.finalVars["OUT"]).toBe("provider-value");
    });
  });
});
