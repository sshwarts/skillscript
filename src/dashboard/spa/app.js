// Dashboard SPA — vanilla JS + template literals. No framework, no bundler.
// Talks to the runtime's MCP server via POST /rpc.

const POLL_INTERVAL_MS = 30_000;
const RPC_ENDPOINT = "/rpc";

let nextRpcId = 1;
let pollTimer = null;
let currentView = null;
const state = {
  skills: [],
  triggers: [],
  metrics: null,
  capabilities: null,
  lastUpdate: null,
};

// ─── RPC client ─────────────────────────────────────────────────────────────

async function rpc(method, params) {
  const body = { jsonrpc: "2.0", id: nextRpcId++, method, ...(params ? { params } : {}) };
  const res = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${json.error.code}: ${json.error.message}`);
  return json.result;
}

async function callTool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args ?? {} });
  // tools/call returns { content: [{ type: "text", text: "..." }] }
  if (!result?.content?.[0]?.text) throw new Error("Tool returned no content");
  return JSON.parse(result.content[0].text);
}

// ─── State refresh (polling) ────────────────────────────────────────────────

async function refresh() {
  const ts = new Date();
  document.getElementById("poll-status").textContent = `polling…`;
  try {
    const [catalog, triggers, metrics, capabilities] = await Promise.all([
      // v0.9.8 — skill_list returns SkillCatalog (pre-grouped by audience).
      // Dashboard wants the full picture (all categories); flatten the
      // groups into a single array for the existing rendering code.
      callTool("skill_list", { filter: { audience: "all" } }),
      callTool("list_triggers", {}),
      callTool("health_metrics", {}),
      callTool("runtime_capabilities", { include: ["mcpConnectors", "mcpConnectorClasses", "localModels", "dataStores", "skillStores", "agentConnectors", "runtimeVersion"] }),
    ]);
    state.skills = [
      ...(catalog.receives ?? []),
      ...(catalog.skills ?? []),
      ...(catalog.headless ?? []),
    ];
    state.triggers = triggers;
    state.metrics = metrics;
    state.capabilities = capabilities;
    state.lastUpdate = ts;
    document.getElementById("poll-status").textContent = `last updated ${ts.toLocaleTimeString()}`;
    renderCurrentView();
  } catch (err) {
    document.getElementById("poll-status").textContent = `poll failed: ${err.message}`;
  }
}

function startPolling() {
  refresh();
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
}

// ─── Views ──────────────────────────────────────────────────────────────────

function renderOverview() {
  const m = state.metrics;
  const totalFires = m?.totalFires ?? 0;
  const skillCount = state.skills.length;
  const statusCounts = state.skills.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});
  const triggerCount = state.triggers.length;
  const connectors = m ? Object.entries(m.perConnector) : [];

  // Compute top errors by class across all skills
  const errorTotals = {};
  if (m) {
    for (const skill of Object.values(m.perSkill)) {
      for (const opKind in skill.errorCategories) {
        for (const cls in skill.errorCategories[opKind]) {
          errorTotals[cls] = (errorTotals[cls] ?? 0) + skill.errorCategories[opKind][cls];
        }
      }
    }
  }
  const topErrors = Object.entries(errorTotals).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return `
    <h2>Overview</h2>
    <section>
      <div class="kpi-row">
        <div class="kpi"><div class="label">Skills</div><div class="value">${skillCount}</div></div>
        <div class="kpi"><div class="label">Approved</div><div class="value">${statusCounts.Approved ?? 0}</div></div>
        <div class="kpi"><div class="label">Triggers</div><div class="value">${triggerCount}</div></div>
        <div class="kpi"><div class="label">Fires (24h)</div><div class="value">${totalFires}</div></div>
      </div>
    </section>

    <section>
      <h2>Top errors (24h)</h2>
      ${topErrors.length === 0
        ? `<div class="empty">No errors observed.</div>`
        : `<table><thead><tr><th>Error class</th><th>Count</th></tr></thead><tbody>
            ${topErrors.map(([cls, n]) => `<tr><td>${esc(cls)}</td><td>${n}</td></tr>`).join("")}
          </tbody></table>`}
    </section>

    <section>
      <h2>Connector health (24h)</h2>
      ${connectors.length === 0
        ? `<div class="empty">No connector activity observed.</div>`
        : `<table><thead><tr><th>Connector</th><th>Calls</th><th>Error rate</th><th>p50</th><th>p95</th><th>p99</th></tr></thead><tbody>
            ${connectors.map(([name, c]) => {
              const errRate = `${(c.errorRate * 100).toFixed(1)}%`;
              const flag = c.errorRate > 0.05 ? ` <span class="badge error">degraded</span>` : "";
              return `<tr><td>${esc(name)}${flag}</td><td>${c.callCount}</td><td>${errRate}</td><td>${c.latencyMs.p50}ms</td><td>${c.latencyMs.p95}ms</td><td>${c.latencyMs.p99}ms</td></tr>`;
            }).join("")}
          </tbody></table>`}
    </section>
  `;
}

function renderSkills() {
  if (state.skills.length === 0) {
    return `<h2>Skills</h2><section><div class="empty">No skills in store. Use <code>skillfile init</code> + <code>skillfile run</code> to populate.</div></section>`;
  }
  return `
    <h2>Skills (${state.skills.length})</h2>
    <section>
      <table>
        <thead>
          <tr><th>Name</th><th>Status</th><th>Description</th><th>Version</th></tr>
        </thead>
        <tbody>
          ${state.skills.map((s) => `
            <tr onclick="window.location.hash='#skill/${encodeURIComponent(s.name)}'">
              <td><strong>${esc(s.name)}</strong></td>
              <td><span class="badge ${esc(s.status)}">${esc(s.status)}</span></td>
              <td>${esc(s.description ?? "—")}</td>
              <td><code>${esc(s.version?.slice(0, 8) ?? "—")}</code></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </section>
  `;
}

async function renderSkillDetail(name) {
  try {
    // v0.13.3 — source moved out of skill_metadata into dedicated skill_read.
    // Call both in parallel; skill_read may fail if the skill name doesn't
    // resolve (load() throws), so guard it to keep the detail view rendering.
    const [meta, readResult] = await Promise.all([
      callTool("skill_metadata", { name }),
      callTool("skill_read", { name }).catch(() => null),
    ]);
    const { metadata, versions, recent_fires, approval } = meta;
    const source = readResult?.source ?? null;
    const metrics = state.metrics?.perSkill?.[name];
    const triggersForSkill = state.triggers.filter((t) => t.skillName === name);
    // v0.9.0 — surface approval-gate state. When Approved + gate-not-ok,
    // body was edited after approval so the human needs to re-stamp.
    // Defensive: pre-v0.9.0 server builds don't return `approval` at all
    // (undefined); treat that as "no info" so the SPA degrades cleanly.
    const approvalBadge = !approval
      ? ""
      : approval.gate_ok
        ? ` <span class="badge ok">verified</span>`
        : ` <span class="badge error" title="${esc(approval.reason ?? "")}">re-approval needed</span>`;
    const approvalBanner = (approval && !approval.gate_ok && metadata.status === "Approved")
      ? `<div class="remediation" style="margin-top: 12px;"><strong>Approval token stale.</strong> ${esc(approval.reason ?? "")}. Re-transition to Approved to stamp a fresh token.</div>`
      : "";
    return `
      <div style="margin-bottom: 8px;"><a href="#" onclick="event.preventDefault(); window.history.back();" style="font-size: 0.9em; color: #6c757d;">← Back</a></div>
      <h2>Skill: ${esc(metadata.name)} <span class="badge ${esc(metadata.status)}">${esc(metadata.status)}</span>${approvalBadge}</h2>

      <section>
        <h2>Status</h2>
        <p>${esc(metadata.description ?? "(no description)")}</p>
        ${approvalBanner}
        <div style="margin-top: 12px; display: flex; gap: 8px;">
          ${["Draft", "Approved", "Disabled"].filter((s) => s !== metadata.status || (s === "Approved" && approval && !approval.gate_ok)).map((s) => `
            <button class="${s === "Disabled" ? "danger" : ""}" onclick="updateStatus('${esc(name)}','${s}')">
              ${s === "Approved" && metadata.status === "Approved" ? "Re-approve (refresh token)" : `Transition to ${s}`}
            </button>
          `).join("")}
        </div>
      </section>

      <section>
        <h2>Source</h2>
        ${source ? `<pre>${esc(source)}</pre>` : `<div class="empty">Source not available.</div>`}
      </section>

      ${renderComposesSection(name, source)}

      <section>
        <h2>Triggers (${triggersForSkill.length})</h2>
        ${triggersForSkill.length === 0
          ? `<div class="empty">No triggers registered for this skill.</div>`
          : `<table>
              <thead><tr><th>Source</th><th>Name</th><th>Registered</th></tr></thead>
              <tbody>
                ${triggersForSkill.map((t) => `
                  <tr>
                    <td>${esc(t.source)}</td>
                    <td><code>${esc(t.name)}</code></td>
                    <td>${new Date(t.registeredAt * 1000).toLocaleString()}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>`}
      </section>

      <section>
        <h2>Metrics (24h)</h2>
        ${metrics
          ? `<dl class="kv">
              <dt>Fires</dt><dd>${metrics.fireCount}</dd>
              <dt>Success</dt><dd>${metrics.successCount}</dd>
              <dt>Errors</dt><dd>${metrics.errorCount}</dd>
              <dt>Success rate</dt><dd>${(metrics.successRate * 100).toFixed(1)}%</dd>
            </dl>`
          : `<div class="empty">No traces recorded in window.</div>`}
      </section>

      <section>
        <h2>Recent fires (${recent_fires.length})</h2>
        ${recent_fires.length === 0
          ? `<div class="empty">No fires recorded.</div>`
          : recent_fires.map((fire) => {
              const ts = new Date(fire.fired_at_ms).toLocaleString();
              const status = fire.errors.length === 0
                ? `<span class="badge ok">ok</span>`
                : `<span class="badge error">err</span>`;
              return `
                <div style="border-bottom: 1px solid #e6e8eb; padding: 12px 0;">
                  <div style="display: flex; align-items: center; gap: 12px;">
                    ${status}
                    <code style="font-size: 11px; color: #6c757d;">${esc(fire.trace_id.slice(0, 8))}</code>
                    <span>${ts}</span>
                    <span style="color: #6c757d; margin-left: auto;">${fire.duration_ms}ms · ${fire.ops.length} ops</span>
                  </div>
                  ${fire.errors.map((e) => `
                    <div class="remediation">
                      <strong>${esc(e.class)}</strong> in ${esc(e.target)}/${esc(e.opKind)}: ${esc(e.message)}
                      ${e.remediation ? `<div style="margin-top: 4px; color: #4a5158;">→ ${esc(e.remediation)}</div>` : ""}
                    </div>
                  `).join("")}
                </div>
              `;
            }).join("")}
      </section>

      <section>
        <h2>Version history (${versions.length})</h2>
        <table>
          <thead><tr><th>Version</th><th>Status</th><th>Changed at</th></tr></thead>
          <tbody>
            ${versions.slice().reverse().map((v) => `
              <tr>
                <td><code>${esc(v.version)}</code></td>
                <td><span class="badge ${esc(v.status)}">${esc(v.status)}</span></td>
                <td>${new Date(v.changed_at * 1000).toLocaleString()}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </section>
    `;
  } catch (err) {
    return `<h2>Skill: ${esc(name)}</h2><section><div class="empty">Failed to load: ${esc(err.message)}</div></section>`;
  }
}

function renderTriggers() {
  return `
    <h2>Triggers</h2>

    <section>
      ${state.triggers.length === 0
        ? `<div class="empty">No triggers registered.</div>`
        : `<table>
            <thead><tr><th>Skill</th><th>Source</th><th>Name</th><th>State</th><th>Registered</th><th></th></tr></thead>
            <tbody>
              ${state.triggers.map((t) => {
                const enabled = t.enabled !== false; // legacy records (pre-v0.9.0) default to enabled
                return `
                <tr>
                  <td><strong>${esc(t.skillName)}</strong></td>
                  <td>${esc(t.source)}</td>
                  <td><code>${esc(t.name)}</code></td>
                  <td><span class="badge ${enabled ? "ok" : "Draft"}">${enabled ? "enabled" : "disabled"}</span></td>
                  <td>${new Date(t.registeredAt * 1000).toLocaleString()}</td>
                  <td style="display: flex; gap: 6px;">
                    <button onclick="setTriggerEnabled('${esc(t.id)}', ${!enabled})">${enabled ? "Disable" : "Enable"}</button>
                    <button class="danger" onclick="unregisterTrigger('${esc(t.id)}')">Unregister</button>
                  </td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>`}
    </section>
  `;
}

function renderConnectors() {
  const caps = state.capabilities;
  const wiredMcp = caps?.mcpConnectors ?? [];
  const wiredLocal = caps?.localModels ?? [];
  const wiredMemory = caps?.dataStores ?? [];
  const wiredSkill = caps?.skillStores ?? [];
  const wiredAgent = caps?.agentConnectors ?? [];
  const classes = caps?.mcpConnectorClasses ?? [];
  const activity = state.metrics ? Object.entries(state.metrics.perConnector) : [];

  const wiredTable = (label, entries, extraCols) => entries.length === 0
    ? ""
    : `<h3>${esc(label)}</h3>
       <table>
         <thead><tr><th>Name</th><th>Class</th><th>Contract</th>${extraCols?.headers ?? ""}</tr></thead>
         <tbody>
           ${entries.map((e) => `
             <tr>
               <td><strong>${esc(e.name)}</strong></td>
               <td><code>${esc(e.implementation)}</code></td>
               <td>${esc(e.contract_version)}</td>
               ${extraCols?.row?.(e) ?? ""}
             </tr>
           `).join("")}
         </tbody>
       </table>`;

  // MCP connectors get an extra "Allowed tools" column (v0.4.1 allowlist).
  const mcpExtra = {
    headers: `<th>Allowed tools</th>`,
    row: (e) => `<td>${e.allowed_tools === null || e.allowed_tools === undefined
      ? `<em>all</em>`
      : e.allowed_tools.length === 0
        ? `<em>none (disabled)</em>`
        : e.allowed_tools.map((t) => `<code>${esc(t)}</code>`).join(" ")}</td>`,
  };

  return `
    <h2>Connectors</h2>
    <section>
      <h3>Wired</h3>
      ${wiredMcp.length + wiredLocal.length + wiredMemory.length + wiredSkill.length + wiredAgent.length === 0
        ? `<div class="empty">No connectors wired in this runtime.</div>`
        : `${wiredTable("MCP", wiredMcp, mcpExtra)}
           ${wiredTable("Local model", wiredLocal)}
           ${wiredTable("Memory store", wiredMemory)}
           ${wiredTable("Skill store", wiredSkill)}
           ${wiredTable("Agent", wiredAgent)}`}
      ${classes.length > 0
        ? `<p class="meta">Available MCP classes for <code>connectors.json</code>: ${classes.map((c) => `<code>${esc(c)}</code>`).join(", ")}</p>`
        : ""}
    </section>
    <section>
      <h3>Activity</h3>
      ${activity.length === 0
        ? `<div class="empty">No connector activity yet. Run a skill that uses <code>$ &lt;connector&gt;.&lt;tool&gt;</code> ops.</div>`
        : `<table>
            <thead><tr><th>Connector</th><th>Calls</th><th>Errors</th><th>p50</th><th>p95</th><th>p99</th><th>Last success</th></tr></thead>
            <tbody>
              ${activity.map(([name, c]) => `
                <tr>
                  <td><strong>${esc(name)}</strong></td>
                  <td>${c.callCount}</td>
                  <td>${c.errorCount} (${(c.errorRate * 100).toFixed(1)}%)</td>
                  <td>${c.latencyMs.p50}ms</td>
                  <td>${c.latencyMs.p95}ms</td>
                  <td>${c.latencyMs.p99}ms</td>
                  <td>${c.lastSuccess_ms ? new Date(c.lastSuccess_ms).toLocaleString() : "—"}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>`}
    </section>
  `;
}

// ─── Write paths ────────────────────────────────────────────────────────────

window.updateStatus = async function (name, newState) {
  if (newState === "Disabled" && !confirm(`Disable '${name}'? Its triggers will stop firing.`)) return;
  try {
    await callTool("skill_status", { name, new_state: newState });
    await refresh();
  } catch (err) {
    alert(`Status update failed: ${err.message}`);
  }
};

// Note: register-trigger intentionally NOT exposed in the SPA — creates
// new autonomous dispatch surface that doesn't appear in the skill source.
// CLI-only (`skillfile register-trigger`) keeps intent explicit. Unregister
// stays in the UI; it removes existing surface (safety, not weapon).

window.unregisterTrigger = async function (id) {
  if (!confirm("Unregister this trigger?")) return;
  try {
    await callTool("unregister_trigger", { trigger_id: id });
    await refresh();
  } catch (err) {
    alert(`Unregister failed: ${err.message}`);
  }
};

window.setTriggerEnabled = async function (id, enabled) {
  try {
    await callTool("set_trigger_enabled", { trigger_id: id, enabled });
    await refresh();
  } catch (err) {
    alert(`Trigger state update failed: ${err.message}`);
  }
};

// ─── Composes section (v0.18.0) ─────────────────────────────────────────────
// Surfaces every skill this one composes via `execute_skill(...)` or
// `inline(...)`. Each ref renders collapsed; click expands to fetch the
// called skill's metadata and render its contract (Description + Vars +
// Returns) — the function-signature view that lets a reviewer see "the
// whole picture" without leaving the page.

function extractCompositionRefs(source) {
  if (!source) return [];
  const refs = [];
  // execute_skill(skill_name="X") or execute_skill(name="X"). Both single
  // and double quotes; back-compat alias accepted.
  const executeRe = /execute_skill\s*\(\s*(?:skill_name|name)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = executeRe.exec(source)) !== null) {
    refs.push({ kind: "execute_skill", name: m[1] });
  }
  // inline(skill="X")
  const inlineRe = /inline\s*\(\s*skill\s*=\s*["']([^"']+)["']/g;
  while ((m = inlineRe.exec(source)) !== null) {
    refs.push({ kind: "inline", name: m[1] });
  }
  // Dedup: one entry per (kind, name) — multiple call sites for the same
  // skill render as a single row.
  const seen = new Set();
  return refs.filter((r) => {
    const key = `${r.kind}:${r.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderComposesSection(currentName, source) {
  const refs = extractCompositionRefs(source);
  if (refs.length === 0) {
    return `<section><h2>Composes</h2><div class="empty">This skill doesn't compose other skills (no <code>execute_skill</code> or <code>inline</code> refs).</div></section>`;
  }
  return `
    <section>
      <h2>Composes (${refs.length})</h2>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${refs.map((r) => `
          <details data-compose-ref="${esc(r.kind)}:${esc(r.name)}" data-parent="${esc(currentName)}">
            <summary style="cursor: pointer; padding: 8px 12px; background: #f6f8fa; border-radius: 4px; font-family: monospace;">
              <span class="badge ${r.kind === "execute_skill" ? "ok" : "info"}" style="margin-right: 8px;">${esc(r.kind)}</span>
              <strong>${esc(r.name)}</strong>
              <span style="color: #6c757d; margin-left: 8px; font-size: 0.85em;">${r.kind === "execute_skill" ? "(runtime invocation)" : "(compile-time data inline)"}</span>
            </summary>
            <div class="compose-panel" style="padding: 12px 16px; border-left: 2px solid #e6e8eb; margin-left: 12px; margin-top: 8px;">
              <div class="empty">Loading contract…</div>
            </div>
          </details>
        `).join("")}
      </div>
    </section>
  `;
}

// Lazy-loads the called skill's contract on first expansion. Cached
// inline (re-collapsed details preserve their innerHTML) so subsequent
// opens are free.
async function loadComposeContract(detailsEl) {
  const panel = detailsEl.querySelector(".compose-panel");
  if (!panel || panel.dataset.loaded === "true") return;
  panel.dataset.loaded = "true";
  const [kind, name] = detailsEl.dataset.composeRef.split(":");
  try {
    const meta = await callTool("skill_metadata", { name });
    const m = meta.metadata;
    // For inline (data-only), also fetch the body since it bakes at
    // compile time — reviewer sees what literally lands in the
    // compiled artifact.
    let inlinedBody = null;
    if (kind === "inline") {
      const readResult = await callTool("skill_read", { name }).catch(() => null);
      inlinedBody = readResult?.source ?? null;
    }
    panel.innerHTML = renderContractPanel(name, kind, m, inlinedBody);
  } catch (err) {
    panel.innerHTML = `<div class="remediation"><strong>Failed to load:</strong> ${esc(err.message)}</div>`;
  }
}

function renderContractPanel(name, kind, meta, inlinedBody) {
  const desc = meta.description
    ? `<div style="margin-bottom: 12px;">${esc(meta.description)}</div>`
    : `<div class="empty" style="margin-bottom: 12px;">(no <code># Description:</code> declared)</div>`;
  const vars = Array.isArray(meta.vars) && meta.vars.length > 0
    ? `<dl class="kv"><dt>Takes (<code># Vars:</code>)</dt><dd>${meta.vars.map((v) => `<code>${esc(v)}</code>`).join(", ")}</dd></dl>`
    : `<dl class="kv"><dt>Takes</dt><dd><span class="empty">(no declared <code># Vars:</code>)</span></dd></dl>`;
  const returns = Array.isArray(meta.returns) && meta.returns.length > 0
    ? `<dl class="kv"><dt>Returns (<code># Returns:</code>)</dt><dd>${meta.returns.map((r) => `<code>${esc(r)}</code>`).join(", ")}</dd></dl>`
    : `<dl class="kv"><dt>Returns</dt><dd><span class="empty">(no declared <code># Returns:</code> — caller sees <code>outputs</code> + <code>transcript</code> only)</span></dd></dl>`;
  const authorBadge = meta.author ? ` <span style="color: #6c757d; font-size: 0.85em;">by ${esc(meta.author)}</span>` : "";
  const drillLink = `<a href="#skill/${encodeURIComponent(name)}" style="font-size: 0.85em;">Open in detail view →</a>`;
  const inlineBodyBlock = inlinedBody !== null
    ? `<details style="margin-top: 12px;"><summary style="cursor: pointer; color: #6c757d; font-size: 0.85em;">Inlined body (bakes at compile)</summary><pre style="margin-top: 8px; font-size: 12px;">${esc(inlinedBody)}</pre></details>`
    : "";
  return `
    <div style="font-size: 0.95em;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
        <strong>${esc(name)}</strong>${authorBadge}
        ${drillLink}
      </div>
      ${desc}
      ${vars}
      ${returns}
      ${inlineBodyBlock}
    </div>
  `;
}

// Delegate the toggle event so dynamically-rendered <details> elements
// in the Composes section trigger the lazy-load. Native `toggle` event
// doesn't bubble, so listen via capture phase on the document.
document.addEventListener("toggle", (e) => {
  if (e.target.tagName === "DETAILS" && e.target.open && e.target.dataset.composeRef) {
    loadComposeContract(e.target);
  }
}, true);

// ─── Routing ────────────────────────────────────────────────────────────────

async function renderCurrentView() {
  const main = document.getElementById("main");
  const hash = window.location.hash.replace(/^#/, "") || "overview";
  // Update nav active state
  for (const link of document.querySelectorAll("nav a")) {
    link.classList.toggle("active", link.getAttribute("href") === `#${hash}`);
  }

  if (hash.startsWith("skill/")) {
    const name = decodeURIComponent(hash.slice("skill/".length));
    currentView = `skill/${name}`;
    main.innerHTML = "Loading…";
    main.innerHTML = await renderSkillDetail(name);
    return;
  }

  currentView = hash;
  switch (hash) {
    case "overview":   main.innerHTML = renderOverview(); break;
    case "skills":     main.innerHTML = renderSkills(); break;
    case "triggers":   main.innerHTML = renderTriggers(); break;
    case "connectors": main.innerHTML = renderConnectors(); break;
    default: main.innerHTML = `<section><div class="empty">Unknown view: ${esc(hash)}</div></section>`;
  }
}

window.addEventListener("hashchange", renderCurrentView);
window.addEventListener("DOMContentLoaded", () => {
  startPolling();
});

// ─── Utils ──────────────────────────────────────────────────────────────────

function esc(s) {
  if (s === undefined || s === null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
