import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";

/**
 * v0.2.8 — discovery + composition. Two new MCP tools per Perry's
 * kickoff (thread `45c167bc`):
 *
 *   help: cold-agent language discovery. Default quickstart + topic
 *     filters (ops / frontmatter / examples / connectors / lint-codes).
 *
 *   execute_skill: public composition primitive. Symmetric with AMP's
 *     amp_execute_skill. Mechanical mode for TestFlight previews.
 *     Recursion-depth guard prevents infinite-loop composition.
 *
 * Also covers the in-skill `$ execute_skill skill_name=...` runtime
 * intercept that lets skills compose without an MCP connector wired.
 */

function rpc(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}) };
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const resp = await server.handle(rpc("tools/call", { name, arguments: args }));
  if ("error" in resp) throw new Error((resp as { error: { message: string } }).error.message);
  const r = resp as { result: { content: Array<{ text: string }> } };
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
}

describe("v0.2.8 — help MCP tool", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v028-help-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("appears in tools/list", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const resp = await mcpServer.handle(rpc("tools/list"));
    const r = (resp as { result: { tools: Array<{ name: string }> } }).result;
    expect(r.tools.map((t) => t.name)).toContain("help");
  });

  it("default call returns quickstart + available topics list", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "help");
    expect(result["topic"]).toBeNull();
    expect(typeof result["content"]).toBe("string");
    expect((result["content"] as string)).toMatch(/quickstart/i);
    expect(result["available_topics"]).toEqual(["ops", "frontmatter", "examples", "composition", "error-handling", "connectors", "lint-codes"]);
    // v0.7.1 quickstart structure — trigger→process→deliver model, three op classes,
    // canonical surface, plus the basics (branching, iteration, lint).
    expect((result["content"] as string)).toMatch(/trigger.*process.*deliver|three.*op.*class/i);
    expect((result["content"] as string)).toMatch(/Shape of a skill file/);
    expect((result["content"] as string)).toMatch(/Result binding/);
    expect((result["content"] as string)).toMatch(/Branching/);
    expect((result["content"] as string)).toMatch(/Iteration/);
    expect((result["content"] as string)).toMatch(/lint_skill/);
  });

  it("topic=ops returns op reference", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "help", { topic: "ops" });
    expect(result["topic"]).toBe("ops");
    const content = result["content"] as string;
    // v0.7.2: ops topic refreshed to canonical surface — three op classes,
    // function-call shapes, ${VAR} substitution, legacy as deprecated table at bottom.
    expect(content).toMatch(/External MCP dispatch/);
    expect(content).toMatch(/Runtime-intrinsic function-calls/);
    expect(content).toMatch(/shell\(command=/);
    expect(content).toMatch(/execute_skill/);
  });

  it("topic=error-handling returns the containment playbook (v0.26.5)", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "help", { topic: "error-handling" });
    expect(result["topic"]).toBe("error-handling");
    const content = result["content"] as string;
    // The four containment primitives + the per-call opt-out answer.
    expect(content).toMatch(/fallible op/i);
    expect(content).toMatch(/\(fallback:/);
    expect(content).toMatch(/# OnError:/);
    expect(content).toMatch(/else:/);
    // The fan-out rule (the morning-brief class) + degrade-loud.
    expect(content).toMatch(/fan-out/i);
    expect(content).toMatch(/Degrade LOUD/);
  });

  it("topic=frontmatter returns header reference", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "help", { topic: "frontmatter" });
    expect(result["topic"]).toBe("frontmatter");
    const content = result["content"] as string;
    expect(content).toMatch(/# Skill:/);
    expect(content).toMatch(/# Status:/);
    expect(content).toMatch(/# Triggers:/);
    expect(content).toMatch(/# Event-type:/);
  });

  it("topic=examples returns 3 canonical worked skills", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "help", { topic: "examples" });
    expect(result["topic"]).toBe("examples");
    const content = result["content"] as string;
    // v0.7.2: examples topic refreshed to canonical surface
    expect(content).toMatch(/## 1\. Minimal/);
    expect(content).toMatch(/## 2\. Cron-fired/);
    expect(content).toMatch(/## 3\. LLM branching/);
  });

  it("topic=connectors reports the wired set when a registry is present", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "help", { topic: "connectors" });
    const content = result["content"] as string;
    expect(content).toMatch(/SkillStores:/);
    expect(content).toMatch(/LocalModels:/);
    expect(content).toMatch(/AgentConnectors:/);
    expect(content).toMatch(/runtime_capabilities/);
  });

  it("topic=lint-codes returns rule index across all three tiers", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "help", { topic: "lint-codes" });
    const content = result["content"] as string;
    expect(content).toMatch(/Tier-1.*error/);
    expect(content).toMatch(/Tier-2.*warning/);
    expect(content).toMatch(/Tier-3.*info/);
    expect(content).toMatch(/undeclared-var/);
    expect(content).toMatch(/unused-augmenting-header/);
  });

  it("invalid topic returns a friendly error message + valid-topics list", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    // Bypass MCP schema enum check by calling the handler directly with an unknown topic.
    // (In practice the MCP layer rejects via JSON schema; this tests the helpResponse fallback.)
    const { helpResponse } = await import("../src/help-content.js");
    const result = helpResponse("nonsense", "0.2.8");
    expect((result["content"] as string)).toMatch(/Unknown topic/);
  });
});

describe("v0.2.8 — execute_skill MCP tool", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v028-exec-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("appears in tools/list", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const resp = await mcpServer.handle(rpc("tools/list"));
    const r = (resp as { result: { tools: Array<{ name: string }> } }).result;
    expect(r.tools.map((t) => t.name)).toContain("execute_skill");
  });

  it("executes a stored skill end-to-end", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await wired.skillStore.store("hello",
      "# Skill: hello\n# Status: Approved\n# Vars: WHO=world\ngreet:\n    emit(text=\"Hello, $(WHO)!\")\ndefault: greet\n");
    const result = await callTool(wired.mcpServer, "execute_skill", { skill_name: "hello" });
    expect(result["skill_name"]).toBe("hello");
    expect((result["transcript"] as string[]).join("\n")).toMatch(/Hello, world!/);
    expect(result["errors"]).toEqual([]);
    expect(result["target_order"]).toEqual(["greet"]);
  });

  it("honors inputs override on # Vars:", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await wired.skillStore.store("hello",
      "# Skill: hello\n# Status: Approved\n# Vars: WHO=world\ngreet:\n    emit(text=\"Hello, $(WHO)!\")\ndefault: greet\n");
    const result = await callTool(wired.mcpServer, "execute_skill", { skill_name: "hello", inputs: { WHO: "Perry" } });
    expect((result["transcript"] as string[]).join("\n")).toMatch(/Hello, Perry!/);
  });

  it("mechanical: true previews dispatch without firing real ops", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await wired.skillStore.store("mech-preview",
      "# Skill: mech-preview\n# Status: Approved\nstep:\n    $ llm prompt=\"hi\" -> R\n    emit(text=\"Result: $(R)\")\ndefault: step\n");
    const result = await callTool(wired.mcpServer, "execute_skill", { skill_name: "mech-preview", mechanical: true });
    expect(result["mechanical"]).toBe(true);
    expect(result["errors"]).toEqual([]);
    // Mechanical mode should bind a self-describing placeholder, no LLM call fired.
    const transcript = (result["transcript"] as string[]).join("\n");
    expect(transcript).toMatch(/preview/i);
  });

  it("missing skill returns structured error (no crash)", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "execute_skill", { skill_name: "nonexistent" });
    const errors = result["errors"] as Array<{ class: string; message: string }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.class).toBe("SkillNotFoundError");
    expect(errors[0]!.message).toMatch(/nonexistent/);
  });

  it("empty skill_name rejects with clear error message", async () => {
    // v0.15.2 — error message changed when `name` became canonical; the
    // empty-name path now hits the "exactly one of `name` or `source`" check.
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await expect(callTool(mcpServer, "execute_skill", { skill_name: "" })).rejects.toThrow(/exactly one of `name` or `source`/i);
  });
});

describe("v0.2.8 — $ execute_skill in-skill composition", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v028-compose-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("parent skill composes a child skill via $ execute_skill", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await wired.skillStore.store("child",
      "# Skill: child\n# Status: Approved\n# Vars: GREETING=hi\nm:\n    emit(text=\"From child: $(GREETING)\")\ndefault: m\n");
    await wired.skillStore.store("parent",
      "# Skill: parent\n# Status: Approved\nm:\n    $ execute_skill skill_name=\"child\" GREETING=\"hello\" -> R\n    emit(text=\"Parent done\")\ndefault: m\n");

    const result = await callTool(wired.mcpServer, "execute_skill", { skill_name: "parent" });
    expect(result["errors"]).toEqual([]);
    const transcript = (result["transcript"] as string[]).join("\n");
    expect(transcript).toMatch(/Parent done/);
  });

  it("recursion-depth guard fires on infinite-loop composition", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    // a → b → a → b → … infinite loop. Guard caps at depth=10. The error
    // fires at the deepest level and gets recorded in that level's
    // errors[]; the top-level call surfaces it inside the nested result
    // chain (tool-call semantics — child errors don't auto-propagate as
    // parent-op errors). We verify the marker shows up anywhere in the
    // serialized result tree.
    // v0.19.10 — explicit `# Returns: R` so the child execute_skill result
    // propagates to final_vars (and thus appears in the serialized result
    // tree). Pre-v0.19.10 the test leaned on the lastBoundVar leak into
    // outputs.text (Perry's `650c5a9c` Finding 3) — that leak is now closed
    // (emissions over lastBoundVar), so error-info propagation must flow
    // through declared returns.
    await wired.skillStore.store("a",
      "# Skill: a\n# Status: Approved\n# Returns: R\nm:\n    $ execute_skill skill_name=\"b\" -> R\n    emit(text=\"a-done\")\ndefault: m\n");
    await wired.skillStore.store("b",
      "# Skill: b\n# Status: Approved\n# Returns: R\nm:\n    $ execute_skill skill_name=\"a\" -> R\n    emit(text=\"b-done\")\ndefault: m\n");

    const result = await callTool(wired.mcpServer, "execute_skill", { skill_name: "a" });
    // Serialize the entire result tree and grep for the recursion marker.
    const serialized = JSON.stringify(result);
    expect(serialized).toMatch(/recursion depth exceeded/i);
  });

  it("v0.2.9 fix: $ execute_skill inputs={...} JSON kwarg propagates to child", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    // v0.17.3 — `# Returns: WHO` declares WHO as the exported surface so
    // the parent's `$(R.final_vars.WHO)` reach lands. Pre-Returns, every
    // var leaked into `final_vars`; post-Returns, only declared names
    // propagate. The test's intent (verify input reaches child) is
    // unchanged.
    await wired.skillStore.store("hello",
      "# Skill: hello\n# Status: Approved\n# Vars: WHO=world\n# Returns: WHO\ngreet:\n    emit(text=\"Hello, $(WHO)!\")\ndefault: greet\n");
    // Style 2 — Perry's repro syntax (thread 64445b4f). Was silently dropped in v0.2.8.
    await wired.skillStore.store("parent",
      "# Skill: parent\n# Status: Approved\n# Vars: TARGET_NAME=Perry\nm:\n    $ execute_skill skill_name=\"hello\" inputs={\"WHO\": \"$(TARGET_NAME)\"} -> R\n    emit(text=\"Child WHO: $(R.final_vars.WHO)\")\ndefault: m\n");

    const result = await callTool(wired.mcpServer, "execute_skill", { skill_name: "parent" });
    expect(result["errors"]).toEqual([]);
    expect((result["transcript"] as string[]).join("\n")).toMatch(/Child WHO: Perry/);
  });

  it("v0.2.9 fix: $ execute_skill bare-kwarg style continues to propagate inputs", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    // v0.17.3 — same Returns: WHO declaration as above; see sibling test.
    await wired.skillStore.store("hello",
      "# Skill: hello\n# Status: Approved\n# Vars: WHO=world\n# Returns: WHO\ngreet:\n    emit(text=\"Hello, $(WHO)!\")\ndefault: greet\n");
    // Style 1 — bare kwarg, natural skill grammar
    await wired.skillStore.store("parent",
      "# Skill: parent\n# Status: Approved\n# Vars: TARGET_NAME=Scott\nm:\n    $ execute_skill skill_name=\"hello\" WHO=\"$(TARGET_NAME)\" -> R\n    emit(text=\"Child WHO: $(R.final_vars.WHO)\")\ndefault: m\n");

    const result = await callTool(wired.mcpServer, "execute_skill", { skill_name: "parent" });
    expect(result["errors"]).toEqual([]);
    expect((result["transcript"] as string[]).join("\n")).toMatch(/Child WHO: Scott/);
  });

  it("v0.2.9 fix: tokenizer handles JSON with nested objects and arrays", async () => {
    const { tokenizeKeywordArgs } = await import("../src/parser.js");
    // Plain JSON object
    expect(tokenizeKeywordArgs(`skill_name="hello" inputs={"WHO": "Perry"}`))
      .toEqual([`skill_name="hello"`, `inputs={"WHO": "Perry"}`]);
    // Nested object + array
    expect(tokenizeKeywordArgs(`inputs={"outer": {"inner": "v"}, "list": [1, 2]}`))
      .toEqual([`inputs={"outer": {"inner": "v"}, "list": [1, 2]}`]);
  });

  it("$ execute_skill works without a user-wired MCP connector (built-in intercept)", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    // v0.10 — bootstrap no longer auto-wires `llm` bridge (LocalModel is null
    // by default; adopters wire via `substrate.local_model` in connectors.json).
    // The `$ execute_skill` test ensures the built-in intercept fires for ANY
    // composition op regardless of whether user MCP connectors are wired.
    const connectors = wired.registry.listMcpConnectors();
    expect(connectors.some((c) => c.name === "llm")).toBe(false);
    await wired.skillStore.store("alpha",
      "# Skill: alpha\n# Status: Approved\nm:\n    emit(text=\"alpha-out\")\ndefault: m\n");
    await wired.skillStore.store("beta",
      "# Skill: beta\n# Status: Approved\nm:\n    $ execute_skill skill_name=\"alpha\" -> R\n    emit(text=\"beta done\")\ndefault: m\n");

    const result = await callTool(wired.mcpServer, "execute_skill", { skill_name: "beta" });
    expect(result["errors"]).toEqual([]);
    expect((result["transcript"] as string[]).join("\n")).toMatch(/beta done/);
  });
});
