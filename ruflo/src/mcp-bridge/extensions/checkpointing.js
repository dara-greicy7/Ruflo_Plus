/**
 * checkpointing.js — Durable Execution (LangGraph pattern)
 *
 * Writes an append-only JSONL checkpoint log before and after every tool call.
 * On startup, scans for any 'started' records with no matching 'completed'/'failed'
 * record and reports them — these are tasks that were interrupted mid-execution.
 *
 * Exposed tools:
 *   ext__checkpoints_list  — view recent checkpoints (optionally filter by status)
 *   ext__checkpoints_clear — remove completed checkpoints older than N hours
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class CheckpointingExtension {
  constructor(config = {}) {
    this.config = config;
    // Resolve storage path relative to mcp-bridge directory
    const rawPath = config.storage_path || "./data/checkpoints";
    this.storagePath = resolve(__dirname, "..", rawPath);
    this.checkpointFile = join(this.storagePath, "checkpoints.jsonl");
    this.cleanupHours = config.cleanup_completed_after_hours ?? 24;
    // In-memory index of checkpoint IDs we started in this session
    this._sessionCheckpoints = new Map();
  }

  async initialize() {
    mkdirSync(this.storagePath, { recursive: true });
    this._reportUnfinished();
    this._cleanupOldCompleted();
  }

  // ---------- lifecycle hooks ----------

  beforeToolCall(ctx) {
    const id = randomUUID();
    ctx._checkpointId = id;
    const record = {
      id,
      status: "started",
      toolName: ctx.name,
      args: _truncate(JSON.stringify(ctx.args), 400),
      sessionTs: ctx.sessionTs,
      timestamp: new Date().toISOString(),
    };
    this._sessionCheckpoints.set(id, record);
    _append(this.checkpointFile, record);
  }

  afterToolCall(ctx, result, durationMs) {
    const id = ctx._checkpointId;
    if (!id) return;
    const record = {
      id,
      status: "completed",
      durationMs,
      completedAt: new Date().toISOString(),
    };
    this._sessionCheckpoints.delete(id);
    _append(this.checkpointFile, record);
  }

  onToolError(ctx, error, durationMs) {
    const id = ctx._checkpointId;
    if (!id) return;
    const record = {
      id,
      status: "failed",
      error: error.message,
      durationMs,
      failedAt: new Date().toISOString(),
    };
    this._sessionCheckpoints.delete(id);
    _append(this.checkpointFile, record);
  }

  // ---------- built-in tools ----------

  getTools() {
    return [
      {
        name: "ext__checkpoints_list",
        description:
          "List recent execution checkpoints. Shows which tool calls completed, failed, or are still pending (interrupted). Use status='pending' to see only interrupted tasks.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["all", "pending", "completed", "failed"],
              description: "Filter by status (default: all)",
            },
            limit: {
              type: "number",
              description: "Max number of checkpoints to return (default: 20)",
            },
          },
        },
        _handler: (args) => this._listCheckpoints(args),
      },
      {
        name: "ext__checkpoints_clear",
        description:
          "Remove completed and failed checkpoint records older than the configured cleanup window. Does NOT delete pending (interrupted) checkpoints.",
        inputSchema: { type: "object", properties: {} },
        _handler: () => this._clearCompleted(),
      },
    ];
  }

  // ---------- private helpers ----------

  _reportUnfinished() {
    if (!existsSync(this.checkpointFile)) return;
    try {
      const pending = this._getPendingCheckpoints();
      if (pending.length > 0) {
        console.warn(
          `[Checkpointing] ⚠️  ${pending.length} interrupted checkpoint(s) from previous run:`
        );
        for (const c of pending.slice(0, 10)) {
          console.warn(`  • [${c.id.slice(0, 8)}] ${c.toolName} @ ${c.timestamp}`);
        }
      }
    } catch (_) { /* non-fatal */ }
  }

  _cleanupOldCompleted() {
    if (!existsSync(this.checkpointFile)) return;
    try {
      const cutoff = Date.now() - this.cleanupHours * 3600 * 1000;
      const lines = readFileSync(this.checkpointFile, "utf8").trim().split("\n").filter(Boolean);
      const keepers = lines.filter((l) => {
        try {
          const r = JSON.parse(l);
          const ts = new Date(r.completedAt || r.failedAt || r.timestamp).getTime();
          if (r.status === "completed" || r.status === "failed") return ts > cutoff;
          return true; // always keep started/pending
        } catch {
          return true;
        }
      });
      if (keepers.length < lines.length) {
        writeFileSync(this.checkpointFile, keepers.join("\n") + "\n");
      }
    } catch (_) { /* non-fatal */ }
  }

  _getPendingCheckpoints() {
    if (!existsSync(this.checkpointFile)) return [];
    const lines = readFileSync(this.checkpointFile, "utf8").trim().split("\n").filter(Boolean);
    const records = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    const started = new Map();
    const resolved = new Set();
    for (const r of records) {
      if (r.status === "started") started.set(r.id, r);
      else resolved.add(r.id);
    }
    return [...started.values()].filter((r) => !resolved.has(r.id));
  }

  _listCheckpoints({ status = "all", limit = 20 } = {}) {
    if (!existsSync(this.checkpointFile)) {
      return { checkpoints: [], total: 0, message: "No checkpoint log found." };
    }
    const lines = readFileSync(this.checkpointFile, "utf8").trim().split("\n").filter(Boolean);
    const records = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    // Build resolved set
    const resolved = new Map(); // id → final record
    for (const r of records) {
      if (r.status !== "started") resolved.set(r.id, r);
    }

    const checkpoints = records
      .filter((r) => r.status === "started")
      .map((r) => {
        const res = resolved.get(r.id);
        return {
          id: r.id.slice(0, 8),
          toolName: r.toolName,
          startedAt: r.timestamp,
          status: res ? res.status : "pending",
          durationMs: res?.durationMs,
          completedAt: res?.completedAt || res?.failedAt,
          error: res?.error,
        };
      });

    const filtered =
      status === "all" ? checkpoints : checkpoints.filter((c) => c.status === status);

    return {
      checkpoints: filtered.slice(-limit).reverse(),
      total: filtered.length,
      storageFile: this.checkpointFile,
    };
  }

  _clearCompleted() {
    this._cleanupOldCompleted();
    return { success: true, message: `Cleared completed/failed checkpoints older than ${this.cleanupHours}h.` };
  }
}

// ---------- file helpers ----------

function _append(file, record) {
  try {
    appendFileSync(file, JSON.stringify(record) + "\n");
  } catch (e) {
    console.warn("[Checkpointing] write error:", e.message);
  }
}

function _truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + "…";
}
