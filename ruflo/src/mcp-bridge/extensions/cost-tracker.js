/**
 * cost-tracker.js — Token & Budget Governance (OpenSpace pattern)
 *
 * Intercepts AI provider responses to extract token usage, calculates
 * estimated USD cost using configurable per-model pricing, and enforces
 * a budget cap. Persists cumulative spend to disk across restarts.
 *
 * Integration points:
 *   - onChatCompletion(model, usage, costUsd) — called by the mcp-bridge
 *     chat completions proxy after each non-streaming AI response.
 *
 * Exposed tools:
 *   ext__cost_status — view current session and lifetime spend vs. budget
 *   ext__cost_reset  — reset the session counter (lifetime persists)
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class CostTrackerExtension {
  constructor(config = {}) {
    this.config = config;
    const rawPath = config.storage_path || "./data/costs";
    this.storagePath = resolve(__dirname, "..", rawPath);
    this.costFile = join(this.storagePath, "costs.json");
    this.budgetUsd = config.budget_limit_usd ?? 10.0;
    this.warnAtPercent = config.warn_at_percent ?? 80;
    this.blockOnExceeded = config.block_on_budget_exceeded === true;
    this.pricing = config.pricing || {};

    // Runtime state
    this._session = { inputTokens: 0, outputTokens: 0, costUsd: 0.0, calls: 0 };
    this._lifetime = { inputTokens: 0, outputTokens: 0, costUsd: 0.0, calls: 0 };
    this._budgetExceeded = false;
  }

  async initialize() {
    mkdirSync(this.storagePath, { recursive: true });
    this._loadLifetime();
  }

  // ---------- lifecycle hooks ----------

  beforeToolCall(ctx) {
    // If budget exceeded and blocking mode is on, block all tool calls
    if (this._budgetExceeded && this.blockOnExceeded) {
      ctx.needsApproval = true;
      ctx.approvalResponse = {
        content: [
          {
            type: "text",
            text: `🚫 **Budget exceeded** — all tool calls are blocked.\n\nLifetime spend: $${this._lifetime.costUsd.toFixed(4)} / Budget: $${this.budgetUsd.toFixed(2)}\n\nCall \`ext__cost_reset\` to reset the session counter, or adjust \`budget_limit_usd\` in extensions.config.json.`,
          },
        ],
      };
    }
  }

  // Called by the mcp-bridge /chat/completions proxy
  onChatCompletion(model, usage, inferredCostUsd) {
    if (!usage) return;
    const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
    const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
    const costUsd = inferredCostUsd ?? this._calcCost(model, inputTokens, outputTokens);

    this._session.inputTokens += inputTokens;
    this._session.outputTokens += outputTokens;
    this._session.costUsd += costUsd;
    this._session.calls++;

    this._lifetime.inputTokens += inputTokens;
    this._lifetime.outputTokens += outputTokens;
    this._lifetime.costUsd += costUsd;
    this._lifetime.calls++;

    this._saveLifetime();
    this._checkBudget();

    // Log budget warnings to console
    const pct = (this._lifetime.costUsd / this.budgetUsd) * 100;
    if (pct >= 100) {
      console.warn(`[CostTracker] 🚫 Budget EXCEEDED: $${this._lifetime.costUsd.toFixed(4)} / $${this.budgetUsd}`);
    } else if (pct >= this.warnAtPercent) {
      console.warn(`[CostTracker] ⚠️  ${pct.toFixed(1)}% of budget used ($${this._lifetime.costUsd.toFixed(4)} / $${this.budgetUsd})`);
    }
  }

  // ---------- public helper for the proxy ----------

  calcCost(model, inputTokens, outputTokens) {
    return this._calcCost(model, inputTokens, outputTokens);
  }

  isBudgetExceeded() {
    return this._budgetExceeded;
  }

  // ---------- built-in tools ----------

  getTools() {
    return [
      {
        name: "ext__cost_status",
        description:
          "View current token usage and estimated USD cost. Shows session totals, lifetime totals, budget remaining, and per-model pricing reference.",
        inputSchema: { type: "object", properties: {} },
        _handler: () => this._costStatus(),
      },
      {
        name: "ext__cost_reset",
        description:
          "Reset the session cost counter back to zero. Lifetime totals are preserved. Use this to start a fresh budget tracking window without losing historical data.",
        inputSchema: { type: "object", properties: {} },
        _handler: () => this._resetSession(),
      },
    ];
  }

  // ---------- private helpers ----------

  _calcCost(model, inputTokens, outputTokens) {
    const p = this._findPricing(model);
    return (inputTokens / 1_000_000) * p.input_per_mtok + (outputTokens / 1_000_000) * p.output_per_mtok;
  }

  _findPricing(model) {
    if (!model) return this.pricing.default || { input_per_mtok: 3.0, output_per_mtok: 15.0 };
    // Exact match first
    if (this.pricing[model]) return this.pricing[model];
    // Substring match (e.g. "gpt-4o" matches "gpt-4o-2024-08-06")
    for (const [key, val] of Object.entries(this.pricing)) {
      if (key !== "default" && model.startsWith(key)) return val;
    }
    return this.pricing.default || { input_per_mtok: 3.0, output_per_mtok: 15.0 };
  }

  _checkBudget() {
    this._budgetExceeded = this._lifetime.costUsd >= this.budgetUsd;
  }

  _costStatus() {
    const lifetimePct = ((this._lifetime.costUsd / this.budgetUsd) * 100).toFixed(1);
    const remaining = Math.max(0, this.budgetUsd - this._lifetime.costUsd);
    const warnThresh = (this.budgetUsd * this.warnAtPercent) / 100;

    return {
      session: {
        calls: this._session.calls,
        inputTokens: this._session.inputTokens,
        outputTokens: this._session.outputTokens,
        costUsd: Number(this._session.costUsd.toFixed(6)),
      },
      lifetime: {
        calls: this._lifetime.calls,
        inputTokens: this._lifetime.inputTokens,
        outputTokens: this._lifetime.outputTokens,
        costUsd: Number(this._lifetime.costUsd.toFixed(6)),
      },
      budget: {
        limitUsd: this.budgetUsd,
        usedUsd: Number(this._lifetime.costUsd.toFixed(6)),
        remainingUsd: Number(remaining.toFixed(6)),
        usedPercent: `${lifetimePct}%`,
        status: this._budgetExceeded
          ? "🚫 EXCEEDED"
          : parseFloat(lifetimePct) >= this.warnAtPercent
          ? `⚠️  WARNING (>= ${this.warnAtPercent}%)`
          : "✅ OK",
        blockOnExceeded: this.blockOnExceeded,
        warnThresholdUsd: Number(warnThresh.toFixed(4)),
      },
      hint:
        this._budgetExceeded
          ? `Budget exceeded. Call ext__cost_reset to reset session, or update budget_limit_usd in extensions.config.json.`
          : remaining < this.budgetUsd * 0.2
          ? `Only $${remaining.toFixed(4)} remaining. Consider reviewing token usage.`
          : undefined,
    };
  }

  _resetSession() {
    const prev = { ...this._session };
    this._session = { inputTokens: 0, outputTokens: 0, costUsd: 0.0, calls: 0 };
    this._budgetExceeded = this._lifetime.costUsd >= this.budgetUsd;
    return {
      success: true,
      message: "✅ Session cost counter reset.",
      previousSession: {
        calls: prev.calls,
        costUsd: Number(prev.costUsd.toFixed(6)),
      },
      lifetimeCostUsd: Number(this._lifetime.costUsd.toFixed(6)),
    };
  }

  _saveLifetime() {
    try {
      writeFileSync(
        this.costFile,
        JSON.stringify({ lifetime: this._lifetime, savedAt: new Date().toISOString() }, null, 2)
      );
    } catch (e) {
      console.warn("[CostTracker] save error:", e.message);
    }
  }

  _loadLifetime() {
    if (!existsSync(this.costFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.costFile, "utf8"));
      if (data.lifetime) {
        this._lifetime = {
          inputTokens: data.lifetime.inputTokens || 0,
          outputTokens: data.lifetime.outputTokens || 0,
          costUsd: data.lifetime.costUsd || 0,
          calls: data.lifetime.calls || 0,
        };
        this._checkBudget();
      }
    } catch (_) { /* start fresh */ }
  }
}
