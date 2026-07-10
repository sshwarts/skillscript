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
  blockedShellAttempts: null,
  // v1.0 Gate #7 — { enabled, public_key_present } or null (pre-Gate-#7 server).
  securedApproval: null,
  // v0.20.2 — true when the dashboard can sign in-browser (passcode unlock wired).
  dashboardSigning: false,
  lastUpdate: null,
  // v0.23.x — skill_list change-token + cached per-status catalogs, so an
  // unchanged poll reuses the cached catalog instead of rebuilding from N
  // per-skill loads (the remote-store win).
  catalogVersion: null,
  apprCat: null,
  draftCat: null,
  disabledCat: null,
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
    // v0.23.x — send the last change-token; an unchanged store returns
    // { not_modified } per group and we reuse the cached catalog.
    const inm = state.catalogVersion;
    const sl = (status) => ({ filter: { audience: "all", status }, ...(inm ? { if_none_match: inm } : {}) });
    const [draftCat, apprCat, disabledCat, triggers, metrics, capabilities, blocked] = await Promise.all([
      // v0.20.2 — fetch ALL statuses so the Skills view shows Draft + Approved +
      // Disabled (skill_list defaults to Approved-only, which hid Disabled skills
      // entirely — you couldn't find one to re-enable). Three calls + merge since
      // skill_list has no "all-statuses" filter.
      callTool("skill_list", sl("Draft")),
      callTool("skill_list", sl("Approved")),
      callTool("skill_list", sl("Disabled")),
      callTool("list_triggers", {}),
      callTool("health_metrics", {}),
      callTool("runtime_capabilities", { include: ["mcpConnectors", "mcpConnectorClasses", "localModels", "dataStores", "skillStores", "agentConnectors", "securedApproval", "runtimeVersion"] }),
      // v0.18.9 — blocked shell attempts for the Security view's
      // observe→promote loop. Graceful: pre-v0.18.9 servers don't have
      // this tool; catch returns null and the Security view degrades.
      callTool("blocked_shell_attempts", { limit: 100 }).catch(() => null),
    ]);
    // not_modified → keep the cached catalog; otherwise take the fresh one.
    const keep = (cat, prev) => (cat && cat.not_modified ? prev : cat);
    state.apprCat = keep(apprCat, state.apprCat);
    state.draftCat = keep(draftCat, state.draftCat);
    state.disabledCat = keep(disabledCat, state.disabledCat);
    state.catalogVersion = apprCat?.catalog_version ?? draftCat?.catalog_version ?? disabledCat?.catalog_version ?? state.catalogVersion;
    const flatCatalog = (c) => [...(c?.receives ?? []), ...(c?.skills ?? []), ...(c?.headless ?? [])];
    // Approved first, then Draft, then Disabled — grouped by lifecycle.
    state.skills = [...flatCatalog(state.apprCat), ...flatCatalog(state.draftCat), ...flatCatalog(state.disabledCat)];
    state.triggers = triggers;
    state.metrics = metrics;
    state.capabilities = capabilities;
    // v0.9.0+ servers may omit securedApproval (pre-Gate-#7) → null = "unsecured".
    state.securedApproval = capabilities?.securedApproval ?? null;
    // v0.20.2 — can the dashboard sign in-browser? (passcode unlock wired)
    state.dashboardSigning = await fetch("/signing-status").then((r) => r.json()).then((j) => j?.enabled === true).catch(() => false);
    state.blockedShellAttempts = blocked;
    state.lastUpdate = ts;
    renderSecuredBanner();
    // v0.21.0 — surface the running runtime version next to the poll timestamp.
    const ver = state.capabilities?.runtimeVersion;
    document.getElementById("poll-status").textContent =
      `last updated ${ts.toLocaleTimeString()}${ver ? ` · skillscript v${ver}` : ""}`;
    renderCurrentView();
  } catch (err) {
    document.getElementById("poll-status").textContent = `poll failed: ${err.message}`;
  }
}

function startPolling() {
  refresh();
  pollTimer = setInterval(pollIfVisible, POLL_INTERVAL_MS);
  // v0.23.x — visibility-gate the poll. Don't fire skill_list every 30s while
  // the tab is backgrounded; against a remote SkillStore each poll is network
  // traffic. On becoming visible again, refresh immediately so the view isn't
  // stale.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
}

function pollIfVisible() {
  if (!document.hidden) refresh();
}

// ─── Secured mode (v1.0 Gate #7) ────────────────────────────────────────────
// When the runtime runs in secured mode it holds no approval private key — it
// can VERIFY approvals (public key) but cannot GRANT them. Approval is an
// out-of-band operator action: `skillfile approve <name>` reads the operator's
// private key at the terminal and signs. The dashboard is a REVIEW surface, not
// a SIGNING surface (privilege separation keeps the key off this process).

function securedModeOn() {
  return state.securedApproval?.enabled === true;
}

// The exact command an operator runs to approve a skill. Kept in one place so
// the queue and the detail view stay consistent.
function approveCommand(name) {
  return `skillfile approve ${shellQuote(name)}`;
}
function shellQuote(s) {
  return /^[A-Za-z0-9._-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`;
}

function renderSecuredBanner() {
  const el = document.getElementById("secured-banner");
  if (!el) return;
  const sa = state.securedApproval;
  if (sa?.enabled !== true) { el.innerHTML = ""; return; }
  if (sa.public_key_present === false) {
    // Secured but no verifier wired — a misconfiguration: every effectful op is
    // refused and no approval can verify. Loud, because nothing will run.
    el.innerHTML = `<div class="banner banner-error">
      <strong>Secured mode is ON but no approval public key is wired.</strong>
      Every effectful op is refused and no skill can be approved. Set
      <code>SKILLSCRIPT_APPROVAL_PUBLIC_KEY_FILE</code> (and provision a keypair)
      then restart the runtime.
    </div>`;
    return;
  }
  const approvalLine = state.dashboardSigning
    ? `Approve in-browser after a one-time passcode unlock (or <code>skillfile approve &lt;name&gt;</code> at a terminal).`
    : `Approval requires the operator's key: <code>skillfile approve &lt;name&gt;</code> at the terminal — the dashboard reviews, it does not sign.`;
  el.innerHTML = `<div class="banner banner-secured">
    <strong>🔒 Secured mode</strong> — unapproved skills cannot execute any
    effectful op. ${approvalLine}
  </div>`;
}

// ─── Views ──────────────────────────────────────────────────────────────────

// v1.0 Gate #7 — the approval queue. Surfaces every Draft skill awaiting
// operator approval, each with a glance of its security signals so the operator
// can triage WHAT to review before opening the body. The "approve" action is
// deliberately a copyable command, not a button: signing happens at the
// terminal where the operator's private key lives, never on this process.
async function renderApprovals() {
  const secured = securedModeOn();
  // The "needs approval" set = every skill the gate refuses (gate_ok === false),
  // excluding intentionally-retired Disabled skills. That's two cases:
  //   • Draft skills — never approved.
  //   • Approved-but-stale — Approved status with a body the gate rejects
  //     (in secured mode: no/legacy/invalid signature — the v1-migration corpus).
  // The 30s poll only sees Approved, so the queue queries Draft + Approved
  // explicitly and filters Approved by gate_ok (now on every skill_list entry).
  let pending = [];
  try {
    const [draftCat, apprCat] = await Promise.all([
      callTool("skill_list", { filter: { audience: "all", status: "Draft" } }),
      callTool("skill_list", { filter: { audience: "all", status: "Approved" } }),
    ]);
    const flat = (c) => [...(c.receives ?? []), ...(c.skills ?? []), ...(c.headless ?? [])];
    const drafts = flat(draftCat).map((s) => ({ ...s, _why: "draft" }));
    const stale = flat(apprCat).filter((s) => s.gate_ok === false).map((s) => ({ ...s, _why: "stale" }));
    pending = [...drafts, ...stale];
  } catch (err) {
    return `<h2>Approvals</h2><section><div class="empty">Failed to load the approval queue: ${esc(err.message)}</div></section>`;
  }
  const staleCount = pending.filter((s) => s._why === "stale").length;
  const signLine = state.dashboardSigning
    ? `Review the source, then click <strong>Approve</strong> (a one-time passcode unlocks signing for this session).`
    : `Review the source, then sign at a terminal that can read your approval key.`;
  const intro = secured
    ? `<p>Secured mode is <strong>ON</strong>. Each skill below is inert — no
       effectful op will run until it is approved. ${staleCount > 0 ? `${staleCount} carry a stale/legacy approval (e.g. a pre-secured v1 stamp) and need re-signing${state.dashboardSigning ? "" : ` — the fastest path is <code>skillfile reapprove --apply</code> at a terminal`}.` : ""}
       ${signLine}</p>`
    : `<p>Secured mode is <strong>OFF</strong> — Draft skills can be approved
       in-page from their detail view (the runtime self-stamps). Turn on secured
       mode (<code>SKILLSCRIPT_SECURED_MODE=true</code>) to require key-signed
       approval. The queue below still shows what's pending review.</p>`;
  if (pending.length === 0) {
    return `<h2>Approvals</h2><section>${intro}<div class="empty">Nothing awaiting approval — every skill is Approved (and valid) or Disabled.</div></section>`;
  }
  // Fetch each skill's source so we can show its security-signal summary inline.
  // skill_read may fail (load() throws) — degrade that row to "source N/A".
  const sources = await Promise.all(
    pending.map((s) => callTool("skill_read", { name: s.name }).then((r) => r?.source ?? null).catch(() => null)),
  );
  const rows = pending.map((s, i) => {
    const src = sources[i];
    const sig = src ? collectSecuritySignals(src) : null;
    const sigBadges = sig ? approvalSignalBadges(sig) : `<span class="empty">source N/A</span>`;
    const whyBadge = s._why === "stale"
      ? `<span class="badge error" title="Approved status, but the body lacks a valid signature">re-approval needed</span>`
      : `<span class="badge Draft">Draft</span>`;
    const cmd = approveCommand(s.name);
    return `
      <tr>
        <td><a href="#skill/${encodeURIComponent(s.name)}"><strong>${esc(s.name)}</strong></a> ${whyBadge}<br>
            <span style="color:#6c757d;font-size:0.85em;">${esc(s.description ?? "—")}</span></td>
        <td>${sigBadges}</td>
        <td>
          <a href="#skill/${encodeURIComponent(s.name)}">Review →</a>
          ${!secured ? "" : (state.dashboardSigning
            ? `<button class="primary" onclick="approveInBrowser('${esc(s.name).replace(/'/g, "\\'")}')">Approve</button>`
            : `<div class="approve-cmd"><code>${esc(cmd)}</code><button class="copy-btn" onclick="copyText('${esc(cmd).replace(/'/g, "\\'")}', this)">copy</button></div>`)}
        </td>
      </tr>`;
  }).join("");
  return `
    <h2>Approvals (${pending.length})</h2>
    <section>
      ${intro}
      <table>
        <thead><tr><th>Skill</th><th>Security signals</th><th>Action</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

// Compact security-signal badges for the queue triage column.
function approvalSignalBadges(sig) {
  const b = [];
  if (sig.writeOps > 0) b.push(`<span class="badge error" title="mutation ops">${sig.writeOps} write</span>`);
  if (sig.unsafeShell > 0) b.push(`<span class="badge error" title="unsafe bash">${sig.unsafeShell} unsafe</span>`);
  if (sig.approvedOps > 0) b.push(`<span class="badge error" title="per-op author authorization">${sig.approvedOps} approved=</span>`);
  if (sig.autonomous) b.push(`<span class="badge error" title="bypasses human-in-loop"># Autonomous</span>`);
  if (sig.shellOps > 0) b.push(`<span class="badge Draft" title="shell ops${sig.shellBinaries.length ? `: ${sig.shellBinaries.join(", ")}` : ""}">${sig.shellOps} shell</span>`);
  if (sig.wakeAddresses > 0) b.push(`<span class="badge Draft" title="@session wake">${sig.wakeAddresses} wake</span>`);
  if (sig.cronTriggers > 0) b.push(`<span class="badge" title="autonomous cron fire">${sig.cronTriggers} cron</span>`);
  return b.length ? b.join(" ") : `<span class="badge ok">no signals</span>`;
}

// v0.20.2 — in-browser approval. Click Approve → POST /approve. If the session
// isn't unlocked, prompt for the passcode once (POST /unlock), then retry. The
// unlock is session-scoped server-side, so subsequent approvals don't re-prompt.
async function postJson(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

window.approveInBrowser = async function (name) {
  try {
    let res = await postJson("/approve", { name });
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      if (body.needs_passcode) {
        const pass = window.prompt(`Enter the approval passcode to sign '${name}'.\n(Unlocks signing for ~15 min — you can approve more without re-entering.)`);
        if (!pass) return;
        const unlock = await postJson("/unlock", { passcode: pass });
        if (unlock.status !== 200) { alert("Incorrect passcode."); return; }
        res = await postJson("/approve", { name });
      }
    }
    const out = await res.json().catch(() => ({}));
    if (res.status === 200 && out.approved) {
      await refresh();
      renderCurrentView();
    } else {
      alert(`Approve failed: ${out.error || ("HTTP " + res.status)}`);
    }
  } catch (err) {
    alert(`Approve failed: ${err.message}`);
  }
};

// Operator-only destructive delete. Preflight-then-commit: a first POST without
// force is a pure scan — it returns any reverse-dependents without touching
// anything, so we surface them in a SINGLE confirm before re-POSTing with force.
// Deletion is permanent — no trash, no restore — so the confirm framing is
// high-stakes.
window.deleteSkill = async function (name) {
  try {
    // Preflight scan first so the one confirm can name any dependents.
    const pre = await postJson("/delete", { name });
    const scan = await pre.json().catch(() => ({}));
    if (pre.status !== 200) {
      alert(`Delete failed: ${scan.error || ("HTTP " + pre.status)}`);
      return;
    }
    const deps = Array.isArray(scan.dependents) ? scan.dependents : [];
    const warn = deps.length
      ? `⚠ '${name}' is referenced by: ${deps.join(", ")}.\nThose skills will fail to dispatch it once it's gone.\n\n`
      : "";
    if (!confirm(`${warn}Permanently delete '${name}'?\nThis erases the skill and its version history. There is no undo.`)) return;
    const res = await postJson("/delete", { name, force: true });
    const out = await res.json().catch(() => ({}));
    if (res.status === 200 && out.deleted) {
      location.hash = "#skills";
      await refresh();
      renderCurrentView();
    } else {
      alert(`Delete failed: ${out.error || ("HTTP " + res.status)}`);
    }
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
};

window.copyText = function (text, btn) {
  const done = () => { if (btn) { const o = btn.textContent; btn.textContent = "copied"; setTimeout(() => { btn.textContent = o; }, 1200); } };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
};
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch { /* no-op */ }
  document.body.removeChild(ta);
}

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
              <td>${skillStatusBadge(s)}</td>
              <td>${esc(s.description ?? "—")}</td>
              <td><code>${esc(s.version?.slice(0, 8) ?? "—")}</code></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </section>
  `;
}

// v0.21.0 — gate-aware status badge (adopter finding 576632ca). A legacy skill
// stored `Approved` but failing the secured gate (e.g. a v1 stamp) WON'T run —
// badging it a plain green "Approved" while the Approvals tab lists it as
// "needs approval" reads as a contradiction. Show "re-approval needed" here too
// so both views agree on the truth (what the gate will actually do).
function skillStatusBadge(s) {
  if (s.status === "Approved" && s.gate_ok === false) {
    return `<span class="badge error" title="Approved status, but the body lacks a valid signature — won't run until re-approved">re-approval needed</span>`;
  }
  return `<span class="badge ${esc(s.status)}">${esc(s.status)}</span>`;
}

async function renderSkillDetail(name) {
  try {
    // v0.13.3 — source moved out of skill_preflight into dedicated skill_read.
    // Call both in parallel; skill_read may fail if the skill name doesn't
    // resolve (load() throws), so guard it to keep the detail view rendering.
    const [meta, readResult] = await Promise.all([
      callTool("skill_preflight", { name }),
      callTool("skill_read", { name }).catch(() => null),
    ]);
    const { metadata, versions, recent_fires, approval, contract } = meta;
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
        ${renderStatusActions(name, metadata, approval)}
        <div style="margin-top: 16px; border-top: 1px solid #eee; padding-top: 12px;">
          <button class="danger" onclick="deleteSkill('${esc(name).replace(/'/g, "\\'")}')">Delete skill</button>
          <span style="color:#6c757d; font-size:0.85em; margin-left:8px;">permanent — no undo; warns if other skills reference it, then frees the name</span>
        </div>
      </section>

      ${renderEffectfulFootprintPanel(contract?.effectful_footprint)}

      ${source ? renderSecuritySignalsPanel(source) : ""}

      <section>
        <h2>Source</h2>
        ${source ? `<pre class="skill-source">${renderHighlightedSkillBody(source)}</pre>` : `<div class="empty">Source not available.</div>`}
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

// Status-transition controls for the skill detail view. The subtlety is
// Approved: in SECURED mode the runtime can't self-stamp (skill_status →
// Approved throws ApprovalRejectedError — the key lives at the operator's
// terminal, not on this process), so we surface the `skillfile approve`
// command instead of a button that would only error. Draft/Disabled never
// grant effects, so they stay one-click in both modes.
function renderStatusActions(name, metadata, approval) {
  const secured = securedModeOn();
  const status = metadata.status;
  const staleApproved = status === "Approved" && approval && !approval.gate_ok;

  // Non-approval transitions (revoke / demote) — always plain buttons.
  const buttons = ["Draft", "Disabled"]
    .filter((s) => s !== status)
    .map((s) => `<button class="${s === "Disabled" ? "danger" : ""}" onclick="updateStatus('${esc(name)}','${esc(s)}')">Transition to ${s}</button>`)
    .join("");

  // The Approved action. Shown when not-yet-Approved OR stale (needs re-stamp).
  // v0.20.2 — a Disabled skill is "re-enabled" (the user's mental model); in
  // secured mode re-enabling = re-signing, since disabling stripped the token.
  const isDisabled = status === "Disabled";
  const needsApprove = status !== "Approved" || staleApproved;
  const headText = isDisabled ? "Re-enable this skill" : (staleApproved ? "Re-approve (body changed since signing)" : "Approve this skill");
  const btnText = isDisabled ? "Re-enable" : "Approve";
  let approveBlock = "";
  if (needsApprove) {
    if (secured && state.dashboardSigning) {
      // v0.20.2 — in-browser signing wired: click to approve (passcode-unlocked).
      approveBlock = `
        <div class="approve-panel">
          <div class="approve-panel-head">${headText}</div>
          <p>Signs with the operator's key after a one-time passcode unlock (review the source below first).</p>
          <button class="primary" onclick="approveInBrowser('${esc(name).replace(/'/g, "\\'")}')">${btnText}</button>
        </div>`;
    } else if (secured) {
      const cmd = approveCommand(name);
      approveBlock = `
        <div class="approve-panel">
          <div class="approve-panel-head">${headText}</div>
          <p>Secured mode: ${isDisabled ? "re-enabling re-signs the skill" : "approval is signed"} with the operator's key at a terminal — not from this dashboard. Review the source below, then run:</p>
          <div class="approve-cmd"><code>${esc(cmd)}</code><button class="copy-btn" onclick="copyText('${esc(cmd).replace(/'/g, "\\'")}', this)">copy</button></div>
        </div>`;
    } else {
      approveBlock = `<button onclick="updateStatus('${esc(name)}','Approved')">${isDisabled ? "Re-enable" : (staleApproved ? "Re-approve (refresh token)" : "Transition to Approved")}</button>`;
    }
  }

  return `<div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start;">
    ${buttons}
    ${!secured ? approveBlock : ""}
  </div>${secured ? approveBlock : ""}`;
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

// v0.18.9 — security highlighting in the skill source viewer. Two
// severity tiers visualized as soft background tints in the <pre> body
// so a human reviewer can scan-prioritize "what's risky in this skill":
//
//   HIGH (orange tint) — bypasses human-in-loop OR has unbounded blast radius:
//     - `unsafe=true` kwarg (bash interpretation enabled)
//     - `# Autonomous: true` frontmatter (no human-in-loop)
//     - `approved="..."` kwarg (per-op author authorization)
//     - `$ skill_write`, `$ data_write`, `file_write(...)` (mutation ops)
//
//   MEDIUM (yellow tint) — touches OS / live-session surfaces:
//     - `shell(...)` ops (OS-level dispatch even when allowlisted)
//     - `notify(agent="X@session", ...)` (wake-class interrupt)
//
// Implementation: regex-based annotation pass over the already-esc'd
// source string. Each pattern wraps its match in a <span class=...>
// with low-alpha background. Patterns are deliberately conservative —
// false negatives are fine (the highlight aids scanning, not gating);
// false positives are worse because they desensitize the reviewer.
function renderHighlightedSkillBody(source) {
  let body = esc(source);
  // HIGH tier — must apply on the esc'd string, so patterns reference
  // entity-escaped quote chars (e.g., approved=&quot;...&quot;).
  const highPatterns = [
    // Frontmatter signal: `# Autonomous: true`
    /(^|\n)(# Autonomous:\s*true)/g,
    // Per-op author authorization kwarg
    /(approved=&quot;[^&]*&quot;)/g,
    // Unsafe shell axis
    /(unsafe\s*=\s*true)/g,
    // Mutation ops (substrate writes + filesystem writes + skill writes)
    /(file_write\s*\()/g,
    /(\$\s*skill_write\b)/g,
    /(\$\s*data_write\b)/g,
  ];
  // MEDIUM tier — shell() ops + wake-class notify
  const mediumPatterns = [
    /(shell\s*\()/g,
    /(notify\s*\(\s*agent\s*=\s*&quot;[^&]*@[^&]*&quot;)/g,
  ];
  for (const re of highPatterns) {
    body = body.replace(re, (_match, p1, p2) => {
      // Only the `# Autonomous:` pattern has a second CAPTURE group (the
      // leading newline/BOL is p1, the signal is p2). The single-group
      // patterns receive the match OFFSET as the third arg — a NUMBER, not a
      // capture — so test for a string, not `!== undefined`, or the offset
      // gets rendered as highlighted text (e.g. `$ data_write2861`).
      const hasPrefixGroup = typeof p2 === "string";
      const prefix = hasPrefixGroup ? p1 : "";
      const captured = hasPrefixGroup ? p2 : p1;
      return `${prefix}<span class="sig-high">${captured}</span>`;
    });
  }
  for (const re of mediumPatterns) {
    body = body.replace(re, (m) => `<span class="sig-medium">${m}</span>`);
  }
  return body;
}

// v0.18.9 — security signals summary panel. Glance-first surface
// showing aggregated counts so a reviewer knows WHAT to look for before
// scanning the body. Pairs with renderHighlightedSkillBody() (the
// WHERE).
// v0.21.0 — the authoritative "what does it touch" least-privilege checklist
// for the human approver. Unlike renderSecuritySignalsPanel (regex over the
// source), this is the AST-derived effectful_footprint from skill_preflight —
// the SAME op enumeration the capability gate authorizes — so it's the truth of
// what the skill can do when signed, not a textual approximation. Surfaced right
// at the approve action so the operator sees the surface they're signing off.
function renderEffectfulFootprintPanel(fp) {
  if (!fp) return ""; // source not loadable / parse failed → no contract to show
  const items = [];
  if (fp.connectors.length > 0) {
    items.push(`<li class="sig-medium-text">Dispatches to ${fp.connectors.length} MCP connector${fp.connectors.length === 1 ? "" : "s"}: ${fp.connectors.map((c) => `<code>${esc(c)}</code>`).join(", ")}</li>`);
  }
  if (fp.builtins.length > 0) {
    items.push(`<li class="sig-info-text">Uses ${fp.builtins.length} built-in op${fp.builtins.length === 1 ? "" : "s"}: ${fp.builtins.map((b) => `<code>${esc(b)}</code>`).join(", ")}</li>`);
  }
  if (fp.file_writes > 0) {
    items.push(`<li class="sig-high-text">${fp.file_writes} <code>file_write</code> op${fp.file_writes === 1 ? "" : "s"} <small>(writes to the filesystem allowlist)</small></li>`);
  }
  if (fp.file_reads > 0) {
    items.push(`<li class="sig-medium-text">${fp.file_reads} <code>file_read</code> op${fp.file_reads === 1 ? "" : "s"}</li>`);
  }
  if (fp.unsafe_shell > 0) {
    items.push(`<li class="sig-high-text">${fp.unsafe_shell} unsafe (full-bash) shell op${fp.unsafe_shell === 1 ? "" : "s"}</li>`);
  }
  const safeShellBins = fp.shell_binaries.filter((b) => b !== "bash" || fp.unsafe_shell === 0);
  if (safeShellBins.length > 0) {
    items.push(`<li class="sig-medium-text">Runs shell ${safeShellBins.length === 1 ? "binary" : "binaries"}: ${safeShellBins.map((b) => `<code>${esc(b)}</code>`).join(", ")} <small>(allowlist-gated)</small></li>`);
  }
  if (fp.notifies > 0) {
    items.push(`<li class="sig-medium-text">${fp.notifies} <code>notify</code> agent-wake op${fp.notifies === 1 ? "" : "s"}</li>`);
  }
  const body = items.length === 0
    ? `<p class="empty">Pure — no connector, shell, file, or notify ops. Nothing effectful to authorize.</p>`
    : `<ul class="security-signals">${items.join("")}</ul>
       <p><small>This is the AST-derived footprint the capability gate authorizes — the surface this skill can touch once approved. Confirm every line is least-privilege before signing.</small></p>`;
  return `
    <section>
      <h2>What this skill touches</h2>
      ${body}
    </section>
  `;
}

function renderSecuritySignalsPanel(source) {
  const sig = collectSecuritySignals(source);
  const items = [];
  if (sig.shellOps > 0) {
    items.push(`<li class="sig-medium-text">${sig.shellOps} shell op${sig.shellOps === 1 ? "" : "s"}${sig.shellBinaries.length > 0 ? ` (binaries: ${sig.shellBinaries.map(esc).join(", ")})` : ""}</li>`);
  }
  if (sig.unsafeShell > 0) {
    items.push(`<li class="sig-high-text">${sig.unsafeShell} unsafe shell op${sig.unsafeShell === 1 ? "" : "s"} <small>(requires <code>SKILLSCRIPT_ENABLE_UNSAFE_SHELL=true</code> AND <code>bash</code> on allowlist)</small></li>`);
  }
  if (sig.autonomous) {
    items.push(`<li class="sig-high-text"><code># Autonomous: true</code> <small>(bypasses human-in-loop on mutation ops)</small></li>`);
  }
  if (sig.approvedOps > 0) {
    items.push(`<li class="sig-high-text">${sig.approvedOps} <code>approved="..."</code> per-op authorization${sig.approvedOps === 1 ? "" : "s"}</li>`);
  }
  if (sig.writeOps > 0) {
    items.push(`<li class="sig-high-text">${sig.writeOps} mutation op${sig.writeOps === 1 ? "" : "s"} <small>(<code>skill_write</code> / <code>data_write</code> / <code>file_write</code>)</small></li>`);
  }
  if (sig.wakeAddresses > 0) {
    items.push(`<li class="sig-medium-text">${sig.wakeAddresses} <code>@session</code> wake-class deliver${sig.wakeAddresses === 1 ? "" : "s"}</li>`);
  }
  if (sig.cronTriggers > 0) {
    items.push(`<li class="sig-info-text">${sig.cronTriggers} cron trigger${sig.cronTriggers === 1 ? "" : "s"} <small>(autonomous fire)</small></li>`);
  }
  if (items.length === 0) return "";
  return `
    <section>
      <h2>Security signals</h2>
      <ul class="security-signals">
        ${items.join("")}
      </ul>
      <p><small>Scan the source below — highlighted spans match these signals. <span class="sig-high">Orange</span> = review carefully; <span class="sig-medium">yellow</span> = worth noting.</small></p>
    </section>
  `;
}

function collectSecuritySignals(source) {
  const lines = source.split("\n");
  let shellOps = 0;
  let unsafeShell = 0;
  let autonomous = false;
  let approvedOps = 0;
  let writeOps = 0;
  let wakeAddresses = 0;
  let cronTriggers = 0;
  const shellBinaries = new Set();
  for (const line of lines) {
    if (/^# Autonomous:\s*true\s*$/i.test(line)) autonomous = true;
    if (/^# Triggers:\s*cron:/i.test(line)) cronTriggers++;
    const shellMatch = /shell\s*\(\s*command\s*=\s*"([^"]+)"/.exec(line);
    if (shellMatch !== null) {
      shellOps++;
      const cmd = shellMatch[1].trim();
      const isUnsafe = /unsafe\s*=\s*true/.test(line);
      if (isUnsafe) {
        unsafeShell++;
        shellBinaries.add("bash");
      } else if (cmd.length > 0 && !cmd.startsWith("${") && !cmd.startsWith("$(")) {
        const binary = /^([^\s]+)/.exec(cmd);
        if (binary !== null) shellBinaries.add(binary[1]);
      }
    }
    if (/approved\s*=\s*"/.test(line)) approvedOps++;
    if (/\$\s*skill_write\b|\$\s*data_write\b|file_write\s*\(/.test(line)) writeOps++;
    if (/notify\s*\(\s*agent\s*=\s*"[^"]*@[^"]*"/.test(line)) wakeAddresses++;
  }
  return {
    shellOps,
    unsafeShell,
    autonomous,
    approvedOps,
    writeOps,
    wakeAddresses,
    cronTriggers,
    shellBinaries: [...shellBinaries].sort(),
  };
}

// v0.18.9 — Security view. Cross-skill observability for the shell
// allowlist's observe→promote loop. Operator sees what binaries skills
// tried to invoke off-list; decides whether to add any to .env.
function renderSecurity() {
  const blocked = state.blockedShellAttempts;
  if (blocked === null) {
    return `
      <section>
        <h2>Security</h2>
        <div class="empty">
          <strong>blocked_shell_attempts tool unavailable.</strong>
          The runtime serving this dashboard is pre-v0.18.9 and doesn't expose the
          blocked-attempts query surface. Upgrade to v0.18.9+ to see what shell
          binaries skills tried to invoke off the allowlist.
        </div>
      </section>
    `;
  }
  const attempts = blocked.attempts ?? [];
  // Group by binary for the "what should I consider adding?" angle.
  const byBinary = {};
  for (const a of attempts) {
    if (!byBinary[a.binary]) byBinary[a.binary] = { count: 0, skills: new Set(), latest: 0 };
    byBinary[a.binary].count++;
    byBinary[a.binary].skills.add(a.skill_name);
    if (a.fired_at_ms > byBinary[a.binary].latest) byBinary[a.binary].latest = a.fired_at_ms;
  }
  const groups = Object.entries(byBinary).sort((a, b) => b[1].count - a[1].count);
  return `
    <section>
      <h2>Security · Blocked shell attempts</h2>
      <p>
        Skills attempted these shell binaries; the runtime refused each because
        the binary isn't in <code>SKILLSCRIPT_SHELL_ALLOWLIST</code>. Review the
        list — add any you intended to permit to your <code>.env</code>, then
        restart the runtime. Run <code>skillfile shell-audit</code> from the
        CLI to scan the full corpus instead of the recent trace window.
      </p>
      ${attempts.length === 0
        ? `<div class="empty">No blocked shell attempts in the recent trace window.</div>`
        : `<h3>By binary (${groups.length})</h3>
          <table>
            <thead><tr><th>Binary</th><th>Attempts</th><th>Skills</th><th>Last attempt</th></tr></thead>
            <tbody>
              ${groups.map(([binary, g]) => `
                <tr>
                  <td><code>${esc(binary)}</code></td>
                  <td>${g.count}</td>
                  <td>${[...g.skills].sort().map((s) => `<a href="#skill/${encodeURIComponent(s)}">${esc(s)}</a>`).join(", ")}</td>
                  <td>${new Date(g.latest).toLocaleString()}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
          <h3 style="margin-top: 24px;">Recent attempts (${attempts.length})</h3>
          <table>
            <thead><tr><th>When</th><th>Skill</th><th>Target</th><th>Binary</th><th>Body</th></tr></thead>
            <tbody>
              ${attempts.slice(0, 25).map((a) => `
                <tr>
                  <td>${new Date(a.fired_at_ms).toLocaleString()}</td>
                  <td><a href="#skill/${encodeURIComponent(a.skill_name)}">${esc(a.skill_name)}</a></td>
                  <td><code>${esc(a.target)}</code></td>
                  <td><code>${esc(a.binary)}</code></td>
                  <td><code style="font-size: 0.85em;">${esc(a.body)}</code></td>
                </tr>
              `).join("")}
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

// Note: registering a trigger is intentionally NOT exposed in the SPA — it
// creates new autonomous dispatch surface that doesn't appear in the skill
// source. It lives only on the MCP `register_trigger` tool, which keeps intent
// explicit. Unregister stays in the UI; it removes existing surface (safety,
// not weapon).

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
    const meta = await callTool("skill_preflight", { name });
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
  if (hash === "approvals") {
    main.innerHTML = "Loading…";
    main.innerHTML = await renderApprovals();
    return;
  }
  switch (hash) {
    case "overview":   main.innerHTML = renderOverview(); break;
    case "skills":     main.innerHTML = renderSkills(); break;
    case "triggers":   main.innerHTML = renderTriggers(); break;
    case "connectors": main.innerHTML = renderConnectors(); break;
    case "security":   main.innerHTML = renderSecurity(); break;
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
