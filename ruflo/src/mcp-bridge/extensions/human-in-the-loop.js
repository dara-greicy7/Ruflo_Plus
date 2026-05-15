/**
 * human-in-the-loop.js — Approval Gates (LangGraph pattern)
 *
 * Intercepts configured tool calls and blocks execution until a human
 * explicitly approves or rejects them via the ext__approve / ext__reject tools.
 *
 * How it works:
 *  1. beforeToolCall checks if the tool name matches approval_required_tools or
 *     any regex in approval_patterns.
 *  2. If a match: writes a pending approval record to disk and returns an
 *     approval-pending response (ctx.needsApproval = true).
 *  3. The human calls ext__approvals_list to see pending items, then
 *     ext__approve or ext__reject with the approval ID.
 *  4. On the NEXT tool call attempt for the same tool, if an approval exists,
 *     execution proceeds normally.
 *
 * Exposed tools:
 *   ext__approvals_list  — see all pending / recent approvals
 *   ext__approve         — approve a pending tool call by ID
 *   ext__reject          — reject a pending tool call by ID
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class HumanInTheLoopExtension {
  constructor(config = {}) {
    this.config = config;
    const rawPath = config.storage_path || "./data/approvals";
    this.storagePath = resolve(__dirname, "..", rawPath);
    this.approvalsFile = join(this.storagePath, "approvals.json");
    this.requiredTools = new Set(config.approval_required_tools || []);
    this.approvalPatterns = (config.approval_patterns || []).map((p) => new RegExp(p));
    this.autoApproveNonMatching = config.auto_approve_non_matching !== false;
    this.timeoutSeconds = config.approval_timeout_seconds ?? 300;
    // In-memory: id → approval record (supplements the file for fast lookup)
    this._approvals = new Map();
  }

  async initialize() {
    mkdirSync(this.storagePath, { recursive: true });
    this._loadApprovals();
    this._expireTimedOut();
  }

  // ---------- lifecycle hooks ----------

  beforeToolCall(ctx) {
    if (!this._requiresApproval(ctx.name)) return;

    // Build a fingerprint for deduplication (same tool + same args = same pending approval)
    const fingerprint = _fingerprint(ctx.name, ctx.args);

    // Check if there's already an approved decision for this exact call
    const existing = [...this._approvals.values()].find(
      (a) => a.fingerprint === fingerprint && a.status === "approved"
    );
    if (existing) {
      // Consume the approval (one-time use)
      existing.status = "consumed";
      existing.consumedAt = new Date().toISOString();
      this._saveApprovals();
      return; // proceed normally
    }

    // Check if there's already a pending request for this fingerprint
    const pending = [...this._approvals.values()].find(
      (a) => a.fingerprint === fingerprint && a.status === "pending"
    );
    if (pending) {
      ctx.needsApproval = true;
      ctx.approvalResponse = _pendingMessage(pending.id, ctx.name);
      return;
    }

    // Check if it was rejected
    const rejected = [...this._approvals.values()].find(
      (a) => a.fingerprint === fingerprint && a.status === "rejected"
    );
    if (rejected) {
      ctx.needsApproval = true;
      ctx.approvalResponse = _rejectedMessage(rejected.id, ctx.name, rejected.reason);
      // Clean up rejected record so user can try again later
      this._approvals.delete(rejected.id);
      this._saveApprovals();
      return;
    }

    // Create a new pending approval
    const id = randomUUID().slice(0, 8);
    const approval = {
      id,
      fingerprint,
      toolName: ctx.name,
      args: ctx.args,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.timeoutSeconds * 1000).toISOString(),
    };
    this._approvals.set(id, approval);
    this._saveApprovals();

    ctx.needsApproval = true;
    ctx.approvalResponse = _pendingMessage(id, ctx.name);
  }

  // ---------- built-in tools ----------

  getTools() {
    return [
      {
        name: "ext__approvals_list",
        description:
          "List pending tool-call approvals waiting for human review. Returns the approval ID, tool name, args, and when it expires. Use ext__approve or ext__reject to action them.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["all", "pending", "approved", "rejected", "consumed"],
              description: "Filter by status (default: pending)",
            },
          },
        },
        _handler: (args) => this._listApprovals(args),
      },
      {
        name: "ext__approve",
        description:
          "Approve a pending tool call. After approval, the tool call will proceed on the next attempt. Use ext__approvals_list to find the approval ID.",
        inputSchema: {
          type: "object",
          required: ["approval_id"],
          properties: {
            approval_id: { type: "string", description: "The short approval ID (8 chars)" },
            note: { type: "string", description: "Optional note to attach to the approval" },
          },
        },
        _handler: (args) => this._approve(args),
      },
      {
        name: "ext__reject",
        description:
          "Reject a pending tool call. The tool call will be blocked and the reason will be surfaced to the AI.",
        inputSchema: {
          type: "object",
          required: ["approval_id"],
          properties: {
            approval_id: { type: "string", description: "The short approval ID (8 chars)" },
            reason: { type: "string", description: "Reason for rejection (shown to the AI)" },
          },
        },
        _handler: (args) => this._reject(args),
      },
    ];
  }

  // ---------- private helpers ----------

  _requiresApproval(toolName) {
    if (this.requiredTools.has(toolName)) return true;
    return this.approvalPatterns.some((p) => p.test(toolName));
  }

  _listApprovals({ status = "pending" } = {}) {
    this._expireTimedOut();
    const all = [...this._approvals.values()];
    const filtered = status === "all" ? all : all.filter((a) => a.status === status);
    return {
      approvals: filtered.map((a) => ({
        id: a.id,
        toolName: a.toolName,
        args: a.args,
        status: a.status,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
        note: a.note,
        reason: a.reason,
      })),
      total: filtered.length,
      hint:
        filtered.some((a) => a.status === "pending")
          ? "Call ext__approve or ext__reject with the approval_id to action a pending item."
          : "No pending approvals.",
    };
  }

  _approve({ approval_id, note } = {}) {
    const approval = this._approvals.get(approval_id);
    if (!approval) return { success: false, error: `No approval found with ID: ${approval_id}` };
    if (approval.status !== "pending") {
      return { success: false, error: `Approval ${approval_id} is already ${approval.status}` };
    }
    approval.status = "approved";
    approval.approvedAt = new Date().toISOString();
    if (note) approval.note = note;
    this._saveApprovals();
    return {
      success: true,
      message: `✅ Approved: ${approval.toolName} (ID: ${approval_id}). The tool call will proceed on the next attempt.`,
    };
  }

  _reject({ approval_id, reason = "Rejected by human reviewer" } = {}) {
    const approval = this._approvals.get(approval_id);
    if (!approval) return { success: false, error: `No approval found with ID: ${approval_id}` };
    if (approval.status !== "pending") {
      return { success: false, error: `Approval ${approval_id} is already ${approval.status}` };
    }
    approval.status = "rejected";
    approval.rejectedAt = new Date().toISOString();
    approval.reason = reason;
    this._saveApprovals();
    return {
      success: true,
      message: `❌ Rejected: ${approval.toolName} (ID: ${approval_id}). Reason: ${reason}`,
    };
  }

  _expireTimedOut() {
    const now = Date.now();
    let changed = false;
    for (const [id, a] of this._approvals) {
      if (a.status === "pending" && new Date(a.expiresAt).getTime() < now) {
        a.status = "expired";
        a.expiredAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this._saveApprovals();
  }

  _loadApprovals() {
    if (!existsSync(this.approvalsFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.approvalsFile, "utf8"));
      for (const a of data) this._approvals.set(a.id, a);
    } catch (_) { /* start fresh */ }
  }

  _saveApprovals() {
    try {
      writeFileSync(
        this.approvalsFile,
        JSON.stringify([...this._approvals.values()], null, 2)
      );
    } catch (e) {
      console.warn("[HITL] save error:", e.message);
    }
  }
}

// ---------- response helpers ----------

function _pendingMessage(id, toolName) {
  return {
    content: [
      {
        type: "text",
        text: `⏸️  **Human approval required** for \`${toolName}\` (approval ID: \`${id}\`)\n\nThis tool requires human review before it can run.\n\n**Next steps:**\n1. Call \`ext__approvals_list\` to see the pending request and its arguments.\n2. Call \`ext__approve\` with \`approval_id: "${id}"\` to allow it.\n3. Call \`ext__reject\` with \`approval_id: "${id}"\` to block it.\n4. Once approved, retry the original operation.`,
      },
    ],
  };
}

function _rejectedMessage(id, toolName, reason) {
  return {
    content: [
      {
        type: "text",
        text: `❌ **Tool call rejected** for \`${toolName}\` (approval ID: \`${id}\`)\n\nReason: ${reason}\n\nThis tool call has been blocked by a human reviewer. Please adjust your approach and try a different method.`,
      },
    ],
  };
}

function _fingerprint(toolName, args) {
  return `${toolName}::${JSON.stringify(args)}`;
}
