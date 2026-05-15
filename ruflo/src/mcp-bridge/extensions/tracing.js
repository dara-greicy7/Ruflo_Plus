/**
 * tracing.js — Structured Execution Tracing (LangGraph pattern)
 *
 * Records a structured JSONL entry for every tool call: tool name, args digest,
 * result digest, duration, status, and timestamp. Provides full observability
 * into what the AI did and how long each step took.
 *
 * Exposed tools:
 *   ext__traces_recent  — view the N most recent traces
 *   ext__traces_stats   — aggregate stats: call counts, avg duration, error rate per tool
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class TracingExtension {
  constructor(config = {}) {
    this.config = config;
    const rawPath = config.storage_path || "./data/traces";
    this.storagePath = resolve(__dirname, "..", rawPath);
    this.traceFile = join(this.storagePath, "traces.jsonl");
    this.logArgs = config.log_args !== false;
    this.logResults = config.log_results !== false;
    this.maxArgLen = config.max_arg_length ?? 300;
    this.maxResultLen = config.max_result_length ?? 500;
    this.recentLimit = config.recent_limit ?? 50;
    // Rotate file when it exceeds 50k records
    this._rotateThreshold = 50000;
  }

  async initialize() {
    mkdirSync(this.storagePath, { recursive: true });
    // Log session start
    this._writeTrace({
      type: "session_start",
      timestamp: new Date().toISOString(),
      pid: process.pid,
    });
  }

  // ---------- lifecycle hooks ----------

  beforeToolCall(ctx) {
    // Capture start time (already in ctx.startTime set by ExtensionManager)
    ctx._traceStart = Date.now();
  }

  afterToolCall(ctx, result, durationMs) {
    this._writeTrace({
      type: "tool_call",
      traceId: ctx.id,
      toolName: ctx.name,
      args: this.logArgs ? _truncate(JSON.stringify(ctx.args), this.maxArgLen) : undefined,
      result: this.logResults ? _summariseResult(result, this.maxResultLen) : undefined,
      status: "success",
      durationMs,
      timestamp: new Date().toISOString(),
    });
  }

  onToolError(ctx, error, durationMs) {
    this._writeTrace({
      type: "tool_call",
      traceId: ctx.id,
      toolName: ctx.name,
      args: this.logArgs ? _truncate(JSON.stringify(ctx.args), this.maxArgLen) : undefined,
      status: "error",
      error: error.message,
      durationMs,
      timestamp: new Date().toISOString(),
    });
  }

  // ---------- built-in tools ----------

  getTools() {
    return [
      {
        name: "ext__traces_recent",
        description:
          "View the most recent tool call traces. Shows tool name, status, duration, args summary, and result summary for each call. Useful for debugging or auditing what the AI has done.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Number of traces to return (default: 20, max: 100)",
            },
            tool_filter: {
              type: "string",
              description: "Only show traces for this tool name (optional substring match)",
            },
            status_filter: {
              type: "string",
              enum: ["all", "success", "error"],
              description: "Filter by outcome (default: all)",
            },
          },
        },
        _handler: (args) => this._recentTraces(args),
      },
      {
        name: "ext__traces_stats",
        description:
          "Aggregate statistics per tool: total calls, success rate, average duration, error count. Sorted by total call count descending.",
        inputSchema: {
          type: "object",
          properties: {
            since_hours: {
              type: "number",
              description: "Only count traces from the last N hours (default: 24)",
            },
          },
        },
        _handler: (args) => this._traceStats(args),
      },
    ];
  }

  // ---------- private helpers ----------

  _writeTrace(record) {
    try {
      appendFileSync(this.traceFile, JSON.stringify(record) + "\n");
    } catch (e) {
      console.warn("[Tracing] write error:", e.message);
    }
  }

  _readTraces() {
    if (!existsSync(this.traceFile)) return [];
    try {
      return readFileSync(this.traceFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  _recentTraces({ limit = 20, tool_filter, status_filter = "all" } = {}) {
    limit = Math.min(limit, 100);
    let records = this._readTraces().filter((r) => r.type === "tool_call");

    if (tool_filter) {
      records = records.filter((r) => r.toolName?.includes(tool_filter));
    }
    if (status_filter !== "all") {
      records = records.filter((r) => r.status === status_filter);
    }

    const recent = records.slice(-limit).reverse();
    return {
      traces: recent.map((r) => ({
        id: r.traceId?.slice(0, 8),
        tool: r.toolName,
        status: r.status,
        durationMs: r.durationMs,
        timestamp: r.timestamp,
        args: r.args,
        result: r.result,
        error: r.error,
      })),
      total: records.length,
      showing: recent.length,
    };
  }

  _traceStats({ since_hours = 24 } = {}) {
    const cutoff = Date.now() - since_hours * 3600 * 1000;
    const records = this._readTraces().filter(
      (r) => r.type === "tool_call" && new Date(r.timestamp).getTime() > cutoff
    );

    const statsMap = new Map();
    for (const r of records) {
      const key = r.toolName || "unknown";
      if (!statsMap.has(key)) {
        statsMap.set(key, { tool: key, calls: 0, successes: 0, errors: 0, totalDurationMs: 0 });
      }
      const s = statsMap.get(key);
      s.calls++;
      if (r.status === "success") { s.successes++; s.totalDurationMs += r.durationMs || 0; }
      else s.errors++;
    }

    const stats = [...statsMap.values()]
      .sort((a, b) => b.calls - a.calls)
      .map((s) => ({
        tool: s.tool,
        calls: s.calls,
        successRate: s.calls > 0 ? `${((s.successes / s.calls) * 100).toFixed(1)}%` : "n/a",
        avgDurationMs: s.successes > 0 ? Math.round(s.totalDurationMs / s.successes) : null,
        errors: s.errors,
      }));

    return {
      stats,
      totalCalls: records.length,
      window: `last ${since_hours}h`,
      traceFile: this.traceFile,
    };
  }
}

// ---------- helpers ----------

function _truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + "…";
}

function _summariseResult(result, max) {
  if (result === undefined || result === null) return null;
  if (typeof result === "string") return _truncate(result, max);
  if (result && Array.isArray(result.content)) {
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ");
    return _truncate(text, max);
  }
  return _truncate(JSON.stringify(result), max);
}
