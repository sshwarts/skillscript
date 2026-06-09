// v0.4.1 — `RemoteMcpConnector`. Bridges to remote MCP servers via a
// spawned child process (typically `npx mcp-remote ...`). The first
// JSON-instantiable connector class in the closed-set registry; pairs
// with v0.4.0's config-loader infrastructure to make `connectors.json`
// practically useful.
//
// Spec: Perry's v0.4.1 kickoff (c65e77af) + Scott's framing/scope
// answers in `89e2752d`.
//
// **Stdio framing.** Two protocols supported, config-driven:
//   - `"lsp"` (default) — `Content-Length: N\r\n\r\n<body>` per the
//     Language Server Protocol convention. What most MCPs speak.
//   - `"newline"` — one JSON-RPC message per line, newline-delimited.
//     Alternate convention; some lighter-weight MCPs use this shape.
//
// **Lifecycle.** Spawn the child on connector construction (or first
// dispatch); send `initialize`; cache the `tools_available` manifest
// from the response. On dispose, send `shutdown` request, then SIGTERM
// → wait → SIGKILL fallback to prevent orphan processes. Child crash
// → connector goes to an error state; subsequent dispatch throws
// DispatchError. No auto-restart in v0.4.1 (deliberate scope choice
// per the kickoff).

import { spawn, type ChildProcess } from "node:child_process";
import { RUNTIME_VERSION } from "../version.js";
import type {
  McpConnector,
  McpDispatchCtx,
  McpConnectorCapabilities,
  ManifestInfo,
} from "./types.js";

const CONTRACT_VERSION = "1.0.0";

/** Wire-format options for stdio framing between this process and the spawned MCP child. */
export type RemoteMcpFraming = "lsp" | "newline";

/**
 * Configuration shape for a `RemoteMcpConnector` in `connectors.json`.
 * `${VAR}` substitutions are resolved at config-load time (v0.4.0); the
 * resolved values arrive here verbatim. Extra fields (e.g. v0.4.x+
 * `allowed_tools`) flow through the loader's permissive-field handling
 * and are not validated by this constructor — they're handled at
 * dispatch-policy layers above.
 */
export interface RemoteMcpConfig {
  /** Executable to spawn. Typically `"npx"`, `"node"`, or a binary path. */
  command: string;
  /** Argument list for the spawned process. */
  args: string[];
  /** Environment variables for the spawned child. Merged with parent env. */
  env?: Record<string, string>;
  /** Stdio framing convention. Default: `"lsp"`. */
  framing?: RemoteMcpFraming;
  /** Maximum time (ms) to wait for the `initialize` response. Default: 10000. */
  initTimeoutMs?: number;
  /** Maximum time (ms) to wait for a `tools/call` response. Default: 30000. */
  callTimeoutMs?: number;
  /** Maximum time (ms) to wait for graceful shutdown before SIGKILL. Default: 2000. */
  shutdownTimeoutMs?: number;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

/** Connector dispatch error — bridge-side failures surface to skill via this. */
export class RemoteMcpDispatchError extends Error {
  public readonly bridgeCause: unknown;
  constructor(message: string, bridgeCause?: unknown) {
    super(message);
    this.name = "RemoteMcpDispatchError";
    this.bridgeCause = bridgeCause;
  }
}

export class RemoteMcpConnector implements McpConnector {
  static staticCapabilities(): McpConnectorCapabilities {
    return {
      connector_type: "mcp_connector",
      implementation: "RemoteMcpConnector",
      contract_version: CONTRACT_VERSION,
      features: {
        supports_identity_propagation: false,
        supports_streaming_responses: false,
        supports_batch: false,
      },
    };
  }

  /**
   * Closed-set registry factory. Validates config shape, constructs the
   * instance. The spawn + handshake are deferred to first dispatch (or
   * an explicit `start()` call) so config validation can happen
   * synchronously at load time.
   */
  static fromConfig(config: Record<string, unknown>): RemoteMcpConnector {
    const command = config["command"];
    const args = config["args"];
    if (typeof command !== "string" || command === "") {
      throw new Error("RemoteMcpConnector config: `command` must be a non-empty string.");
    }
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      throw new Error("RemoteMcpConnector config: `args` must be an array of strings.");
    }
    const env = config["env"];
    if (env !== undefined) {
      if (env === null || typeof env !== "object" || Array.isArray(env)) {
        throw new Error("RemoteMcpConnector config: `env` must be an object of string values.");
      }
      for (const [k, v] of Object.entries(env)) {
        if (typeof v !== "string") {
          throw new Error(`RemoteMcpConnector config: env['${k}'] must be a string (got ${typeof v}).`);
        }
      }
    }
    const framing = config["framing"];
    if (framing !== undefined && framing !== "lsp" && framing !== "newline") {
      throw new Error(`RemoteMcpConnector config: \`framing\` must be "lsp" or "newline" (got ${JSON.stringify(framing)}).`);
    }
    return new RemoteMcpConnector({
      command,
      args: args as string[],
      env: env as Record<string, string> | undefined,
      framing: framing as RemoteMcpFraming | undefined,
    });
  }

  private child: ChildProcess | undefined;
  private nextRequestId = 1;
  private pending = new Map<number | string, PendingCall>();
  private inboundBuffer = Buffer.alloc(0);
  private initializePromise: Promise<unknown> | undefined;
  private toolsAvailable: string[] = [];
  private errorState: Error | undefined;
  private readonly framing: RemoteMcpFraming;
  private readonly initTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;

  constructor(private readonly config: RemoteMcpConfig) {
    this.framing = config.framing ?? "lsp";
    this.initTimeoutMs = config.initTimeoutMs ?? 10_000;
    this.callTimeoutMs = config.callTimeoutMs ?? 30_000;
    this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? 2_000;
  }

  /**
   * Spawn the child + run the `initialize` handshake. Idempotent;
   * subsequent calls return the same in-flight or completed promise.
   * Called lazily by `call()` on first dispatch.
   */
  start(): Promise<unknown> {
    if (this.initializePromise !== undefined) return this.initializePromise;
    this.initializePromise = this.doStart();
    return this.initializePromise;
  }

  private async doStart(): Promise<unknown> {
    const child = spawn(this.config.command, this.config.args, {
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.on("error", (err) => {
      this.errorState = err;
      this.rejectAllPending(new RemoteMcpDispatchError(`child process error: ${err.message}`, err));
    });
    child.on("exit", (code, signal) => {
      this.errorState ??= new Error(`child process exited (code=${code} signal=${signal ?? "none"})`);
      this.rejectAllPending(new RemoteMcpDispatchError(`child process exited mid-request (code=${code} signal=${signal ?? "none"})`));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Surface child stderr to parent stderr for operator debugging.
      // Most MCP impls write status + errors here.
      process.stderr.write(`[${this.config.command}] ${chunk.toString()}`);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.inboundBuffer = Buffer.concat([this.inboundBuffer, chunk]);
      this.drainInbound();
    });

    // MCP `initialize` request — spec at modelcontextprotocol.io.
    // Minimal shape: protocolVersion + clientInfo + capabilities.
    const initResult = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "skillscript-runtime", version: RUNTIME_VERSION },
      capabilities: {},
    }, this.initTimeoutMs);

    // After initialize, fetch the tools list to populate manifest.
    // tools/list is optional per MCP spec; some servers expose tools
    // via the initialize response directly. Try tools/list; tolerate
    // either shape.
    try {
      const toolsResp = await this.sendRequest("tools/list", undefined, this.callTimeoutMs) as {
        tools?: Array<{ name?: string }>;
      };
      this.toolsAvailable = (toolsResp.tools ?? [])
        .map((t) => t.name)
        .filter((n): n is string => typeof n === "string");
    } catch {
      // tools/list unsupported — leave toolsAvailable empty; manifest
      // will reflect "unknown".
    }

    return initResult;
  }

  async call(
    toolName: string,
    args: Record<string, unknown>,
    _ctxOverrides?: McpDispatchCtx,
  ): Promise<unknown> {
    if (this.errorState !== undefined) {
      throw new RemoteMcpDispatchError(`RemoteMcpConnector in error state: ${this.errorState.message}`, this.errorState);
    }
    await this.start();
    if (this.errorState !== undefined) {
      throw new RemoteMcpDispatchError(`RemoteMcpConnector in error state after start: ${(this.errorState as Error).message}`, this.errorState);
    }
    const result = await this.sendRequest("tools/call", {
      name: toolName,
      arguments: args,
    }, this.callTimeoutMs) as { content?: unknown; isError?: boolean };

    // MCP convention: `isError: true` indicates inner-tool error even
    // when JSON-RPC succeeded. Surface as DispatchError so the skill's
    // else: / OnError: machinery can catch it (matches the c580de5
    // contract from T1).
    if (result?.isError === true) {
      throw new RemoteMcpDispatchError(`${toolName} returned isError: ${JSON.stringify(result.content)}`);
    }
    // Return the raw JSON-RPC result (including the `{content, isError}`
    // wrapper). Runtime's `unwrapToolResult` does the MCP-convention
    // unwrap: `[{type:"text", text:"<JSON>"}]` → `JSON.parse(text)` so
    // skills get parsed objects bound directly, not a wrapped envelope.
    return result;
  }

  async manifest(): Promise<ManifestInfo<"mcp_connector">> {
    await this.start();
    // Args are NOT returned verbatim — they may contain env-substituted
    // secrets (e.g. `Authorization: Bearer ${API_KEY}` substituted at
    // wiring time to a literal token). `runtime_capabilities` surfaces
    // manifests through the MCP wire, so leaking the substituted args
    // exposes credentials. Surface count + redaction flag instead.
    return {
      capabilities_version: "1",
      manifest: {
        kind: "remote",
        command: this.config.command,
        args_count: this.config.args.length,
        args_redacted: true,
        framing: this.framing,
        tools_available: this.toolsAvailable,
      },
    };
  }

  /**
   * Graceful shutdown. Best-effort `shutdown` JSON-RPC request, then
   * SIGTERM, then SIGKILL fallback after `shutdownTimeoutMs`. Idempotent.
   */
  async dispose(): Promise<void> {
    const child = this.child;
    if (child === undefined || child.exitCode !== null) return;
    try {
      // Best-effort; ignore errors — we're shutting down anyway.
      await Promise.race([
        this.sendRequest("shutdown", undefined, 1000),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    } catch {
      // Ignore.
    }
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, this.shutdownTimeoutMs);
      child.once("exit", () => {
        clearTimeout(timeoutHandle);
        resolve();
      });
    });
  }

  /** For tests + observability — names of tools surfaced by the initialize handshake. */
  getToolsAvailable(): readonly string[] {
    return this.toolsAvailable;
  }

  // ─── Internal: JSON-RPC plumbing ────────────────────────────────────────

  private sendRequest(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<unknown> {
    if (this.child === undefined) {
      throw new RemoteMcpDispatchError(`sendRequest('${method}') called before start()`);
    }
    if (this.child.exitCode !== null) {
      throw new RemoteMcpDispatchError(`sendRequest('${method}') after child exit (code=${this.child.exitCode})`);
    }
    const id = this.nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const encoded = this.encodeFrame(request);
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        // v0.19.9 — clearer init-timeout error. A timed-out `initialize` is
        // very often a framing mismatch (child speaks newline-delimited but
        // we sent LSP, or vice versa) — the child can't parse the request
        // and never replies. Closes the adopter `14609652` finding 2:
        // mcp-remote (and most MCP stdio servers per spec) use
        // newline-delimited; default 'lsp' framing silently hangs.
        const hint = method === "initialize"
          ? ` Framing in use: '${this.framing}'. If the server speaks the other framing (e.g., the npm 'mcp-remote' package and most spec-compliant MCP stdio servers use newline-delimited), set "framing": "newline" or "framing": "lsp" explicitly in this connector's config. Other causes: child process exited before handshake (check spawn logs), wrong --header / auth, server requires capabilities the client didn't advertise.`
          : "";
        reject(new RemoteMcpDispatchError(`${method} timed out after ${timeoutMs}ms.${hint}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeoutHandle });
      this.child!.stdin?.write(encoded, (err) => {
        if (err !== null && err !== undefined) {
          clearTimeout(timeoutHandle);
          this.pending.delete(id);
          reject(new RemoteMcpDispatchError(`stdin write failed for ${method}: ${err.message}`, err));
        }
      });
    });
  }

  private encodeFrame(msg: JsonRpcRequest): string {
    const body = JSON.stringify(msg);
    if (this.framing === "lsp") {
      return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
    }
    return `${body}\n`;
  }

  private drainInbound(): void {
    if (this.framing === "lsp") this.drainLsp();
    else this.drainNewline();
  }

  private drainLsp(): void {
    while (true) {
      const headerEnd = this.inboundBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headers = this.inboundBuffer.slice(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(headers);
      if (match === null) {
        // Malformed header — drop everything up to the separator and try again.
        this.inboundBuffer = this.inboundBuffer.slice(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.inboundBuffer.length < bodyStart + len) return; // incomplete; wait for more
      const body = this.inboundBuffer.slice(bodyStart, bodyStart + len).toString("utf8");
      this.inboundBuffer = this.inboundBuffer.slice(bodyStart + len);
      this.handleInboundMessage(body);
    }
  }

  private drainNewline(): void {
    while (true) {
      const nlIdx = this.inboundBuffer.indexOf("\n");
      if (nlIdx < 0) return;
      const line = this.inboundBuffer.slice(0, nlIdx).toString("utf8").trim();
      this.inboundBuffer = this.inboundBuffer.slice(nlIdx + 1);
      if (line !== "") this.handleInboundMessage(line);
    }
  }

  private handleInboundMessage(raw: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(raw) as JsonRpcResponse;
    } catch (err) {
      process.stderr.write(`[RemoteMcpConnector] malformed JSON from child: ${raw.slice(0, 200)}\n`);
      return;
    }
    if (msg.id === undefined) return; // notification — ignore for now
    const pending = this.pending.get(msg.id);
    if (pending === undefined) return; // unknown id — ignore
    this.pending.delete(msg.id);
    clearTimeout(pending.timeoutHandle);
    if (msg.error !== undefined) {
      pending.reject(new RemoteMcpDispatchError(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`, msg.error));
      return;
    }
    pending.resolve(msg.result);
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}
