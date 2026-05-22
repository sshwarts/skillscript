import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer, JsonRpcRequest } from "../mcp-server.js";

/**
 * Dashboard HTTP server (T6b Phase 2). Bundles the SPA assets + a
 * /rpc endpoint that forwards JSON-RPC requests to the runtime's
 * McpServer. Single-process colocation with the runtime — no stdio
 * child process needed.
 *
 * SPA: GET / and GET /index.html serve index.html; GET /app.js and
 * /styles.css serve the assets. Anything else 404s.
 *
 * RPC: POST /rpc with JSON-RPC 2.0 body; routes to McpServer.handle();
 * responds with JSON-RPC 2.0 result/error.
 *
 * Binds to 127.0.0.1 by default (per kickoff criterion #12 — localhost-
 * only, no multi-user auth in v1). Operators in shared environments
 * configure a reverse proxy with auth.
 */

export interface DashboardServerConfig {
  mcpServer: McpServer;
  port?: number;
  bindAddress?: string;
  /** Absolute path to the directory containing index.html + app.js + styles.css. Auto-detected when omitted. */
  assetsDir?: string;
  /**
   * When false, GET routes for the browser SPA (`/`, `/index.html`,
   * `/app.js`, `/styles.css`) return 404 — only `POST /rpc` is served.
   * v0.2.7 addition supporting `skillfile serve` (headless deployments).
   * Default true preserves existing `skillfile dashboard` behavior.
   */
  mountSpa?: boolean;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export class DashboardServer {
  private readonly mcpServer: McpServer;
  private readonly port: number;
  private readonly bindAddress: string;
  private readonly assetsDir: string;
  private readonly mountSpa: boolean;
  private httpServer: Server | null = null;

  constructor(config: DashboardServerConfig) {
    this.mcpServer = config.mcpServer;
    this.port = config.port ?? 7878;
    this.bindAddress = config.bindAddress ?? "127.0.0.1";
    this.assetsDir = config.assetsDir ?? locateAssetsDir();
    this.mountSpa = config.mountSpa ?? true;
  }

  async start(): Promise<void> {
    this.httpServer = createServer((req, res) => {
      void this.handle(req, res);
    });
    return new Promise<void>((resolve) => {
      this.httpServer!.listen(this.port, this.bindAddress, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.httpServer === null) return;
    return new Promise<void>((resolve, reject) => {
      this.httpServer!.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** Exposed for direct testing — doesn't go through the network stack. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://${this.bindAddress}:${this.port}`);
      // /rpc is POST-only — any other method on /rpc is 405 (not falling
      // through to the static handler, which would 404 with misleading
      // semantics).
      if (url.pathname === "/rpc") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        await this.handleRpc(req, res);
        return;
      }
      if (req.method === "GET") {
        if (!this.mountSpa) {
          res.statusCode = 404;
          res.end("Not Found (SPA disabled — running in `serve` mode)");
          return;
        }
        await this.handleStatic(url.pathname, res);
        return;
      }
      res.statusCode = 405;
      res.end("Method Not Allowed");
    } catch (err) {
      res.statusCode = 500;
      res.end(`Internal server error: ${(err as Error).message}`);
    }
  }

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    let rpcReq: JsonRpcRequest;
    try {
      rpcReq = JSON.parse(body) as JsonRpcRequest;
    } catch {
      res.statusCode = 400;
      res.setHeader("content-type", MIME[".json"]!);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }
    const response = await this.mcpServer.handle(rpcReq);
    res.statusCode = 200;
    res.setHeader("content-type", MIME[".json"]!);
    res.end(JSON.stringify(response));
  }

  private async handleStatic(pathname: string, res: ServerResponse): Promise<void> {
    const requested = pathname === "/" ? "/index.html" : pathname;
    const file = join(this.assetsDir, requested);
    if (!file.startsWith(this.assetsDir)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    if (!existsSync(file)) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    const body = await readFile(file);
    res.statusCode = 200;
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.end(body);
  }
}

/** Locate the dashboard SPA assets directory (compiled output, runs from dist/). */
function locateAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Built dist runs from dist/dashboard/server.js; spa/ is sibling.
  // Source dev (vitest) runs from src/dashboard/server.ts; spa/ is sibling.
  const candidates = [
    resolve(here, "spa"),
    resolve(here, "..", "..", "src", "dashboard", "spa"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to src/ even if missing — error surfaces at request time.
  return candidates[0]!;
}
