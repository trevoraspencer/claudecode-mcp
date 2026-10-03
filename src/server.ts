/**
 * The stdio MCP server. Thin by design: task state lives on disk and in the
 * per-task runner processes, not here (see service.ts).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig, type LoadedConfig } from "./config.js";
import { currentDepth } from "./depth.js";
import { debugLog, warnLog } from "./log.js";
import { ensureStateDir } from "./paths.js";
import { sanitizeForClient } from "./redaction.js";
import { ASK_MAX_S, TaskService, WAIT_MAX_S } from "./service.js";

export function getPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface ServerContext {
  loaded: LoadedConfig;
  stateDir: string;
  depth: number;
  env: NodeJS.ProcessEnv;
}

/**
 * Load config and prepare the state dir. Throws on an invalid config so the
 * process fails at startup, not on the first tool call.
 */
export function prepare(env: NodeJS.ProcessEnv = process.env): ServerContext {
  const loaded = loadConfig(env);
  const stateDir = ensureStateDir(env);
  const depth = currentDepth(env);
  debugLog({
    phase: "startup",
    config_path: loaded.path,
    config_source: loaded.source,
    profiles: Object.keys(loaded.config.profiles),
    state_dir: stateDir,
    depth,
  });
  if (depth >= 1) {
    warnLog({ phase: "startup", depth, message: "nested inside a task; task tools disabled" });
  }
  return { loaded, stateDir, depth, env };
}

// ── input schemas ─────────────────────────────────────────────────────

const taskId = z.string().min(1).max(64).describe("Task id from start_task or list_tasks.");
const model = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/)
  .describe("Model alias or id, e.g. sonnet, opus. auto mode needs sonnet or opus.");
const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const prompt = z
  .string()
  .min(1)
  .max(4 * 1024 * 1024);
const statusEnum = z.enum([
  "starting",
  "running",
  "idle",
  "stalled",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
  "rate_limited",
  "closed",
]);
const recent = z.int().min(0).max(50).optional().describe("How many recent steps to include.");

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function wrap<A>(
  tool: string,
  fn: (args: A, extra: ToolExtra) => Promise<CallToolResult> | CallToolResult,
): (args: A, extra: ToolExtra) => Promise<CallToolResult> {
  return async (args, extra) => {
    const start = Date.now();
    try {
      const result = await fn(args, extra);
      debugLog({ phase: "call_done", tool, duration_ms: Date.now() - start, ok: true });
      return result;
    } catch (err) {
      const message = sanitizeForClient(err instanceof Error ? err.message : String(err));
      debugLog({ phase: "call_done", tool, duration_ms: Date.now() - start, error: message });
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };
}

interface ToolExtra {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
}

export function createServer(ctx: ServerContext): McpServer {
  const server = new McpServer({ name: "claudecode-mcp", version: getPackageVersion() });
  const tasks = new TaskService(ctx.loaded.config, ctx.env);
  // The SDK's generic overloads infer handler types from the zod shape, which
  // is costly to spell out per tool. The SDK still validates every input
  // against the shape at runtime; handlers declare the parsed type they use.
  const reg = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { title: string; description: string; inputSchema: z.ZodRawShape },
    cb: (args: never, extra: ToolExtra) => Promise<CallToolResult>,
  ) => void;

  reg(
    "start_task",
    {
      title: "Start a Claude Code task",
      description:
        "Start Claude Code on a coding task in a repo and return at once with a task_id. " +
        "Runs in the repo folder itself (isolation: in_place). Track it with get_task/wait_task, " +
        "steer it with send_message, stop it with cancel_task.",
      inputSchema: {
        prompt: prompt.describe("The task for Claude."),
        repo: z.string().min(1).max(4096).describe("Absolute path inside allowed_roots."),
        isolation: z
          .enum(["in_place"])
          .optional()
          .describe("Only in_place for now; git worktrees come later."),
        profile: z.string().max(64).optional().describe("Profile name from the server config."),
        model: model.optional(),
        effort: effort.optional(),
        system_prompt: z
          .string()
          .max(100 * 1024)
          .optional()
          .describe("Appended to Claude Code's system prompt."),
        output_schema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("JSON Schema for the final answer (result.structured_output)."),
        max_minutes: z.int().min(1).max(1440).optional().describe("Per-turn cap (can only lower)."),
        name: z.string().max(100).optional(),
      },
    },
    wrap("start_task", async (args: Parameters<TaskService["startTask"]>[0]) =>
      json(await tasks.startTask(args)),
    ),
  );

  reg(
    "get_task",
    {
      title: "Get task status",
      description:
        "Status, last result, usage, rate-limit info, recent steps, and a take-over command.",
      inputSchema: { task_id: taskId, recent },
    },
    wrap("get_task", (args: { task_id: string; recent?: number }) =>
      json(tasks.view(args.task_id, args.recent ?? 10)),
    ),
  );

  reg(
    "wait_task",
    {
      title: "Wait for a task",
      description: `Wait until the task's current turn ends (or timeout_s, max ${WAIT_MAX_S}). Returns the same view as get_task plus wait_timed_out. Call again to keep waiting.`,
      inputSchema: {
        task_id: taskId,
        timeout_s: z.int().min(1).max(WAIT_MAX_S).optional().describe("Default 30."),
        recent,
      },
    },
    wrap(
      "wait_task",
      async (args: { task_id: string; timeout_s?: number; recent?: number }, extra) =>
        json(
          await tasks.waitTask(args.task_id, args.timeout_s ?? 30, args.recent ?? 10, extra.signal),
        ),
    ),
  );

  reg(
    "get_events",
    {
      title: "Page through task events",
      description:
        "Compact transcript events from byte offset `cursor` (0 or a previous next_cursor).",
      inputSchema: {
        task_id: taskId,
        cursor: z.int().min(0).optional(),
        limit: z.int().min(1).max(200).optional().describe("Default 50."),
      },
    },
    wrap("get_events", (args: { task_id: string; cursor?: number; limit?: number }) =>
      json(tasks.getEvents(args.task_id, args.cursor ?? 0, args.limit ?? 50)),
    ),
  );

  reg(
    "send_message",
    {
      title: "Message a task",
      description:
        "Send a message to a task. While a turn runs it joins that turn; with interrupt=true the " +
        "turn stops first. An idle task starts a new turn; a task whose runner exited is resumed.",
      inputSchema: { task_id: taskId, text: prompt, interrupt: z.boolean().optional() },
    },
    wrap("send_message", async (args: { task_id: string; text: string; interrupt?: boolean }) =>
      json(await tasks.sendMessage(args.task_id, args.text, args.interrupt === true)),
    ),
  );

  reg(
    "cancel_task",
    {
      title: "Cancel a task",
      description: "Stop the task's turn and its runner. The session can be resumed later.",
      inputSchema: { task_id: taskId },
    },
    wrap("cancel_task", async (args: { task_id: string }) =>
      json(await tasks.cancelTask(args.task_id)),
    ),
  );

  reg(
    "list_tasks",
    {
      title: "List tasks",
      description: "Task summaries, newest first.",
      inputSchema: {
        status: statusEnum.optional(),
        repo: z.string().max(4096).optional().describe("Only tasks in this folder."),
        limit: z.int().min(1).max(200).optional().describe("Default 50."),
      },
    },
    wrap("list_tasks", (args: Parameters<TaskService["listTasks"]>[0]) =>
      json(tasks.listTasks(args)),
    ),
  );

  reg(
    "ask",
    {
      title: "Ask Claude Code (blocking)",
      description:
        "Ask a question or request a review and wait for the answer. Read-only by default " +
        "(plan mode; file edits blocked). Without repo it runs in an empty temp folder, so put " +
        "the material (diff, text) in the prompt.",
      inputSchema: {
        prompt: prompt.describe("The question, with any material to review."),
        repo: z.string().max(4096).optional().describe("Absolute path inside allowed_roots."),
        profile: z.string().max(64).optional(),
        model: model.optional(),
        effort: effort.optional(),
        timeout_s: z.int().min(1).max(ASK_MAX_S).optional().describe("Default 300."),
        writable: z.boolean().optional().describe("Allow file changes (default false)."),
      },
    },
    wrap("ask", async (args: Parameters<TaskService["ask"]>[0], extra) => {
      const token = extra._meta?.progressToken;
      const progress =
        token === undefined
          ? undefined
          : (elapsed: number, total: number, message: string) => {
              extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { progressToken: token, progress: elapsed, total, message },
                })
                .catch(() => {});
            };
      const text = await tasks.ask(args, extra.signal, progress);
      return { content: [{ type: "text", text }] };
    }),
  );

  return server;
}

export async function serve(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const ctx = prepare(env);
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
}
