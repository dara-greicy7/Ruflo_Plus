/**
 * skill-feedback.js — Auto-Improve Skills (OpenSpace pattern)
 *
 * Tracks success/failure outcomes for every tool call using a rolling window.
 * Computes a success-rate score per tool. Tools that fall below the demotion
 * threshold are flagged as "needs improvement"; tools above the promotion
 * threshold are marked "high confidence".
 *
 * Scores feed back into guidance: the ext__feedback_stats tool surfaces
 * which tools are underperforming so you can adjust prompts or configs.
 *
 * Exposed tools:
 *   ext__feedback_submit  — manually record success/failure for a tool call
 *   ext__feedback_stats   — view per-tool scores and confidence ratings
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class SkillFeedbackExtension {
  constructor(config = {}) {
    this.config = config;
    const rawPath = config.storage_path || "./data/feedback";
    this.storagePath = resolve(__dirname, "..", rawPath);
    this.feedbackFile = join(this.storagePath, "feedback.json");
    this.windowSize = config.window_size ?? 50;
    this.promotionThreshold = config.promotion_threshold ?? 0.80;
    this.demotionThreshold = config.demotion_threshold ?? 0.30;
    // toolName → circular buffer of outcomes (1 = success, 0 = failure)
    this._windows = new Map();
  }

  async initialize() {
    mkdirSync(this.storagePath, { recursive: true });
    this._load();
  }

  // ---------- lifecycle hooks ----------

  afterToolCall(ctx, _result, _durationMs) {
    this._record(ctx.name, 1); // success
  }

  onToolError(ctx, _error, _durationMs) {
    this._record(ctx.name, 0); // failure
  }

  // ---------- built-in tools ----------

  getTools() {
    return [
      {
        name: "ext__feedback_submit",
        description:
          "Manually record a success or failure outcome for a specific tool. Use this when you can observe that a tool produced a wrong or unhelpful result even though it didn't throw an error.",
        inputSchema: {
          type: "object",
          required: ["tool_name", "outcome"],
          properties: {
            tool_name: { type: "string", description: "The full tool name (e.g. ruflo__agent_spawn)" },
            outcome: {
              type: "string",
              enum: ["success", "failure"],
              description: "Whether the tool call was useful",
            },
            note: { type: "string", description: "Optional note about why it succeeded or failed" },
          },
        },
        _handler: (args) => this._submitFeedback(args),
      },
      {
        name: "ext__feedback_stats",
        description:
          "View per-tool skill scores: success rate, call count, confidence rating (high / normal / needs-improvement). Use this to identify tools that need prompt tuning or config adjustments.",
        inputSchema: {
          type: "object",
          properties: {
            sort_by: {
              type: "string",
              enum: ["score", "calls", "name"],
              description: "Sort order (default: score ascending — worst first)",
            },
            min_calls: {
              type: "number",
              description: "Only show tools with at least this many recorded calls (default: 3)",
            },
          },
        },
        _handler: (args) => this._feedbackStats(args),
      },
    ];
  }

  // ---------- private helpers ----------

  _record(toolName, outcome) {
    if (!this._windows.has(toolName)) {
      this._windows.set(toolName, []);
    }
    const window = this._windows.get(toolName);
    window.push(outcome);
    if (window.length > this.windowSize) window.shift();
    this._save();
  }

  _score(toolName) {
    const window = this._windows.get(toolName);
    if (!window || window.length === 0) return null;
    return window.reduce((a, b) => a + b, 0) / window.length;
  }

  _confidence(score) {
    if (score === null) return "unknown";
    if (score >= this.promotionThreshold) return "high";
    if (score <= this.demotionThreshold) return "needs-improvement";
    return "normal";
  }

  _submitFeedback({ tool_name, outcome, note } = {}) {
    const val = outcome === "success" ? 1 : 0;
    this._record(tool_name, val);
    const score = this._score(tool_name);
    const confidence = this._confidence(score);
    return {
      success: true,
      tool: tool_name,
      outcome,
      note,
      updatedScore: score !== null ? `${(score * 100).toFixed(1)}%` : "n/a",
      confidence,
      message:
        confidence === "needs-improvement"
          ? `⚠️  ${tool_name} is underperforming (score: ${(score * 100).toFixed(1)}%). Consider tuning its usage or arguments.`
          : `✅ Feedback recorded.`,
    };
  }

  _feedbackStats({ sort_by = "score", min_calls = 3 } = {}) {
    const rows = [];
    for (const [toolName, window] of this._windows) {
      if (window.length < min_calls) continue;
      const score = this._score(toolName);
      rows.push({
        tool: toolName,
        calls: window.length,
        score,
        scoreStr: score !== null ? `${(score * 100).toFixed(1)}%` : "n/a",
        confidence: this._confidence(score),
      });
    }

    if (sort_by === "score") rows.sort((a, b) => (a.score ?? 1) - (b.score ?? 1));
    else if (sort_by === "calls") rows.sort((a, b) => b.calls - a.calls);
    else rows.sort((a, b) => a.tool.localeCompare(b.tool));

    const needsImprovement = rows.filter((r) => r.confidence === "needs-improvement");
    const highConfidence = rows.filter((r) => r.confidence === "high");

    return {
      stats: rows.map((r) => ({
        tool: r.tool,
        calls: r.calls,
        successRate: r.scoreStr,
        confidence: r.confidence,
      })),
      summary: {
        totalTools: rows.length,
        highConfidence: highConfidence.length,
        needsImprovement: needsImprovement.length,
        flagged: needsImprovement.map((r) => r.tool),
      },
      thresholds: {
        promotion: `>= ${(this.promotionThreshold * 100).toFixed(0)}%`,
        demotion: `<= ${(this.demotionThreshold * 100).toFixed(0)}%`,
        windowSize: this.windowSize,
      },
      hint:
        needsImprovement.length > 0
          ? `⚠️  ${needsImprovement.length} tool(s) below the demotion threshold. Consider reviewing their usage patterns.`
          : "✅ All tracked tools are performing within acceptable ranges.",
    };
  }

  _save() {
    try {
      const data = {};
      for (const [key, val] of this._windows) data[key] = val;
      writeFileSync(this.feedbackFile, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn("[SkillFeedback] save error:", e.message);
    }
  }

  _load() {
    if (!existsSync(this.feedbackFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.feedbackFile, "utf8"));
      for (const [key, val] of Object.entries(data)) {
        if (Array.isArray(val)) this._windows.set(key, val.slice(-this.windowSize));
      }
    } catch (_) { /* start fresh */ }
  }
}
