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
      callTool("runtime_capabilities", { include: ["mcpConnectors", "mcpConnectorClasses", "localModels", "memoryStores", "skillStores", "agentConnectors", "runtimeVersion"] }),
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
    const { metadata, versions, source, recent_fires, approval } = await callTool("skill_metadata", { name });
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
  const wiredMemory = caps?.memoryStores ?? [];
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
        ? `<div class="empty">No connector activity yet. Run a skill that uses <code>$</code>/<code>~</code>/<code>&gt;</code> ops.</div>`
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
