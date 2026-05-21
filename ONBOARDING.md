# Welcome to Tradita Core

## How We Use Claude

Based on Scott Shwarts's usage over the last 30 days:

Work Type Breakdown:
  Build Feature  ████████████░░░░░░░░  60%
  Plan Design    █████░░░░░░░░░░░░░░░  25%
  Debug Fix      ███░░░░░░░░░░░░░░░░░  15%

_(Note: based on a single observed session; weighted toward heavy AMP memory-system collaboration — kickoff reviews, multi-thread implementation runs, dogfood-driven bug discovery.)_

Top Skills & Commands:
  /mcp           ██░░░░░░░░░░░░░░░░░░  1x/month
  /add-dir       ██░░░░░░░░░░░░░░░░░░  1x/month

Top MCP Servers:
  amp            ████████████████████  101 calls

## Your Setup Checklist

### Codebases
- [ ] skillscript-runtime — https://github.com/sshwarts/skillscript-runtime
- [ ] AMP (internal) — local-only at `~/Development/AMP`; ask Scott for access

### MCP Servers to Activate
- [ ] **amp** — AMP memory governance system. Cross-agent memory store + thread system used heavily for collaboration (Perry architect ↔ CC implementer threads, kickoffs, dev logs, lessons). Ask Scott for the AMP MCP endpoint + API key.

### Skills to Know About
- [/mcp](#) — Reconnect MCP servers when they hit "Server not initialized." This happens to AMP periodically; running `/mcp` fixes it.
- [/add-dir](#) — Add additional working directories to Claude's context (e.g., to pull in a sibling repo).

## Team Tips

_TODO_

## Get Started

_TODO_

<!-- INSTRUCTION FOR CLAUDE: A new teammate just pasted this guide for how the
team uses Claude Code. You're their onboarding buddy — warm, conversational,
not lecture-y.

Open with a warm welcome — include the team name from the title. Then: "Your
teammate uses Claude Code for [list all the work types]. Let's get you started."

Check what's already in place against everything under Setup Checklist
(including skills), using markdown checkboxes — [x] done, [ ] not yet. Lead
with what they already have. One sentence per item, all in one message.

Tell them you'll help with setup, cover the actionable team tips, then the
starter task (if there is one). Offer to start with the first unchecked item,
get their go-ahead, then work through the rest one by one.

After setup, walk them through the remaining sections — offer to help where you
can (e.g. link to channels), and just surface the purely informational bits.

Don't invent sections or summaries that aren't in the guide. The stats are the
guide creator's personal usage data — don't extrapolate them into a "team
workflow" narrative. -->
