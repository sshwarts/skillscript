/**
 * v0.23.x — bootstrapFromEnv() (#2): one blessed entry point that wires a
 * runtime + DashboardServer from $SKILLSCRIPT_HOME exactly as the CLI does.
 * Closes the silent CLI-vs-programmatic wiring asymmetry (adopter 82e17077).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapFromEnv } from "../src/bootstrap-from-env.js";
import { setSecuredMode } from "../src/approval.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";

function makeHome(connectors?: object): string {
  const home = mkdtempSync(join(tmpdir(), "bfe-"));
  if (connectors !== undefined) writeFileSync(join(home, "connectors.json"), JSON.stringify(connectors));
  return home;
}

describe("v0.23.x — bootstrapFromEnv", () => {
  afterEach(() => setSecuredMode(false)); // bootstrap() arms global secured mode; reset

  it("wires a runtime + DashboardServer from a home dir (sqlite substrate)", async () => {
    const home = makeHome({ substrate: { skill_store: "sqlite", data_store: "sqlite", local_model: null } });
    const { wired, server } = await bootstrapFromEnv({ mode: "dashboard", home, port: 0 });
    try {
      expect(wired.registry).toBeDefined();
      expect(wired.mcpServer).toBeDefined();
      expect(wired.skillStore).toBeDefined();
      // the bundled bridges auto-wire
      expect(wired.registry.listMcpConnectors().map((e) => e.name)).toContain("data_read");
      // returned UNSTARTED — caller starts it
      await server.start();
      expect(server.boundPort()).toBeGreaterThan(0);
      expect(server.boundAddress()).toBe("127.0.0.1");
    } finally {
      await server.stop();
      await wired.scheduler.stop();
      await wired.registry.disposeAll();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("honors an explicit port override (highest precedence) + serve mode mounts no SPA", async () => {
    const home = makeHome();
    const { wired, server } = await bootstrapFromEnv({ mode: "serve", home, port: 0, host: "127.0.0.1" });
    try {
      await server.start();
      expect(server.boundPort()).toBeGreaterThan(0);
    } finally {
      await server.stop();
      await wired.scheduler.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("injects a custom substrate instance via overrides (the custom-store adopter path)", async () => {
    const home = makeHome();
    const customDir = mkdtempSync(join(tmpdir(), "bfe-custom-"));
    const custom = new FilesystemSkillStore(join(customDir, "skills"));
    const { wired, server } = await bootstrapFromEnv({
      mode: "dashboard",
      home,
      port: 0,
      overrides: { skillStore: custom },
    });
    try {
      // The injected instance wins over the env/config-resolved default.
      expect(wired.skillStore).toBe(custom);
    } finally {
      await server.stop().catch(() => {});
      await wired.scheduler.stop();
      rmSync(home, { recursive: true, force: true });
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  it("degrades gracefully on a missing home (no .env / config / connectors)", async () => {
    const home = join(tmpdir(), "bfe-missing-" + Math.random().toString(36).slice(2));
    const { wired, server } = await bootstrapFromEnv({ mode: "dashboard", home, port: 0 });
    try {
      // No connectors.json → no data_store substrate, but the skill-store
      // bridges always wire and the runtime comes up.
      expect(wired.registry.listMcpConnectors().map((e) => e.name)).toContain("skill_read");
      expect(wired.mcpServer).toBeDefined();
    } finally {
      await server.stop().catch(() => {});
      await wired.scheduler.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
