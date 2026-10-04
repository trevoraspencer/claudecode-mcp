/**
 * HTTP mode: `claudecode-mcp --http` (DESIGN-v2 section 12.4).
 *
 * Stateless Streamable HTTP on loopback only; `tailscale serve` publishes it
 * on the tailnet. Every request to `http.path` must pass, in order: the Host
 * check, the Origin check, and a per-device bearer token. Each POST gets its
 * own `McpServer` and transport, all sharing one `TaskService`, so restart
 * recovery and the queue dispatcher run once per process. `ask` progress
 * notifications stream as SSE within the request.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LOOPBACK_HOSTS } from "./config.js";
import { numFromEnv } from "./env.js";
import { TokenStore, tokensFilePath } from "./http-tokens.js";
import { debugLog, errorLog, infoLog, warnLog } from "./log.js";
import { createServer, createTaskService, prepare } from "./server.js";
import type { TaskService } from "./service.js";

/** Request body cap. Prompts are capped at 4 MiB; JSON escaping can grow them. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_CONNECTIONS = 128;
const HEADERS_TIMEOUT_MS = 30_000;
/** Time to receive a whole request (not to answer it: `ask` may take 600 s). */
const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_GRACE_MS = 10_000;

export interface HttpHandle {
  host: string;
  port: number;
  /** Stop accepting, wait up to the grace period for in-flight requests, then close. */
  close(): Promise<void>;
}

/** The host name from a `Host` header, lowercased, without port or trailing dot. */
export function hostOf(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const h = header.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end < 0 || !/^(?::\d{1,5})?$/.test(h.slice(end + 1))) return undefined;
    return h.slice(1, end);
  }
  const m = /^([^:\s]+?)\.?(?::\d{1,5})?$/.exec(h);
  return m ? m[1] : undefined;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
  // Error answers close the connection, so a client cannot keep streaming
  // an unread body into it (Node would otherwise drain it for keep-alive).
  res.writeHead(status, {
    connection: "close",
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** Read the body up to `max` bytes; larger bodies are refused with 413. */
function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > max) {
    return Promise.reject(new HttpError(413, "request body too large"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        done = true;
        req.pause();
        reject(new HttpError(413, "request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer[ \t]+(\S{1,512})[ \t]*$/i.exec(header ?? "");
  return m?.[1];
}

/** A short, safe label for logs (never a credential). */
function label(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v ? v.replace(/[^\x20-\x7e]/g, "?").slice(0, 120) : undefined;
}

export async function serveHttp(env: NodeJS.ProcessEnv = process.env): Promise<HttpHandle> {
  const ctx = prepare(env);
  if (ctx.depth >= 1) {
    throw new Error("--http refuses to start inside a delegated task (CLAUDECODE_MCP_DEPTH >= 1)");
  }
  const http = ctx.loaded.config.http;
  const tokens = new TokenStore(tokensFilePath(ctx.loaded.config, env));
  const deviceCount = tokens.load();
  const allowedHosts = new Set<string>([...LOOPBACK_HOSTS, ...http.allowed_hosts]);
  const allowedOrigins = new Set(http.allowed_origins);
  // Started only once the port is ours (below): a server that fails to
  // listen must not have run recovery or dispatched anything.
  let tasks: TaskService | undefined;
  const inflight = new Set<ServerResponse>();
  let draining = false;

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const host = hostOf(req.headers.host);
    if (!host || !allowedHosts.has(host)) {
      throw new HttpError(403, "host not allowed");
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      throw new HttpError(403, "origin not allowed");
    }
    const presented = bearer(req.headers.authorization);
    const device = presented === undefined ? undefined : tokens.lookup(presented);
    if (device === undefined) {
      warnLog({
        phase: "http_auth",
        message: presented === undefined ? "missing bearer token" : "unknown bearer token",
        forwarded_for: label(req.headers["x-forwarded-for"]),
        tailnet_user: label(req.headers["tailscale-user-login"]),
      });
      throw new HttpError(401, "unauthorized");
    }
    if (req.method !== "POST") {
      // Stateless mode has no standalone SSE stream and no sessions to delete.
      throw new HttpError(405, "method not allowed");
    }
    const raw = await readBody(req, MAX_BODY_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "parse error: body is not valid JSON");
    }
    if (!tasks) throw new HttpError(503, "starting");
    const mcp = createServer(ctx, tasks);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // A closed response (done, or the client went away) closes this request's
    // server, which aborts its tool calls (wait_task, ask stop waiting).
    res.on("close", () => {
      mcp.close().catch(() => {});
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
    return device;
  }

  const server = createHttpServer((req, res) => {
    const start = Date.now();
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") {
      if (req.method === "GET" || req.method === "HEAD") {
        res.writeHead(200, { connection: "close", "content-type": "text/plain" });
        res.end(req.method === "HEAD" ? undefined : "ok\n");
      } else {
        send(res, 405, "method not allowed", { allow: "GET, HEAD" });
      }
      return;
    }
    if (path !== http.path) {
      send(res, 404, "not found");
      return;
    }
    if (draining) {
      send(res, 503, "shutting down");
      return;
    }
    inflight.add(res);
    res.on("close", () => inflight.delete(res));
    handleMcp(req, res).then(
      (device) =>
        debugLog({
          phase: "http_request",
          device,
          status: res.statusCode,
          duration_ms: Date.now() - start,
        }),
      (err: unknown) => {
        if (err instanceof HttpError) {
          send(
            res,
            err.status,
            err.message,
            err.status === 401
              ? { "www-authenticate": 'Bearer realm="claudecode-mcp"' }
              : err.status === 405
                ? { allow: "POST" }
                : {},
          );
          return;
        }
        errorLog({ phase: "http_request", error: (err as Error)?.message ?? String(err) });
        send(res, 500, "internal error");
      },
    );
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(http.port, http.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  tasks = createTaskService(ctx);
  infoLog({
    phase: "http_listening",
    host: http.host,
    port,
    path: http.path,
    devices: deviceCount,
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      draining = true;
      server.close();
      server.closeIdleConnections();
      const deadline = Date.now() + numFromEnv("CLAUDECODE_MCP_HTTP_GRACE_MS", DEFAULT_GRACE_MS);
      while (inflight.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      server.closeAllConnections();
      infoLog({ phase: "http_stopped", unfinished: inflight.size });
    })();
    return closing;
  };
  return { host: http.host, port, close };
}

/** Run HTTP mode until SIGTERM or SIGINT, then shut down gracefully and exit. */
export async function runHttp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const handle = await serveHttp(env);
  const stop = (signal: string) => {
    infoLog({ phase: "http_signal", signal });
    // Runners are separate, detached processes: they keep running.
    handle.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}
