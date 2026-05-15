/**
 * extensions/index.js — Extension Lifecycle Manager
 *
 * Loads all enabled extensions from extensions.config.json and provides
 * a unified interface for:
 *   - executeWithExtensions()  wrap any tool call with before/after hooks
 *   - onChatCompletion()       forward AI usage data to cost tracker
 *   - getAdditionalTools()     merge extension tools into the tool list
 *
 * Extensions implemented:
 *   checkpointing     — durable execution (LangGraph pattern)
 *   human_in_the_loop — approval gates    (LangGraph pattern)
 *   tracing           — execution tracing  (LangGraph pattern)
 *   skill_feedback    — auto-improve       (OpenSpace pattern)
 *   cost_tracker      — budget governance  (OpenSpace pattern)
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

import { CheckpointingExtension }   from "./checkpointing.js";
import { HumanInTheLoopExtension }  from "./human-in-the-loop.js";
import { TracingExtension }         from "./tracing.js";
import { SkillFeedbackExtension }   from "./skill-feedback.js";
import { CostTrackerExtension }     from "./cost-tracker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "../../config/extensions.config.json");

// =============================================================================
// Extension Manager
// =============================================================================

class ExtensionManager {
  constructor() {
    this._config       = this._loadConfig();
    this._extensions   = [];          // all initialized extension instances
    this._costTracker  = null;        // direct reference for onChatCompletion
    this._extraTools   = [];          // tools contributed by extensions
    this._initialized  = false;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async initialize() {
    if (this._initialized) return;

    const cfg = this._config.extensions || {};

    const candidates = [
      { key: "checkpointing",     Cls: CheckpointingExtension  },
      { key: "human_in_the_loop", Cls: HumanInTheLoopExtension },
      { key: "tracing",           Cls: TracingExtension        },
      { key: "skill_feedback",    Cls: SkillFeedbackExtension  },
      { key: "cost_tracker",      Cls: CostTrackerExtension    },
    ];

    for (const { key, Cls } of candidates) {
      const extCfg = cfg[key] || {};
      // An extension is enabled unless explicitly disabled
      if (extCfg.enabled === false) {
        console.log(`[Extensions] ○ ${key} (disabled)`);
        continue;
      }
      try {
        const inst = new Cls(extCfg);
        await inst.initialize();
        this._extensions.push(inst);

        // Keep direct reference to cost tracker for the proxy
        if (key === "cost_tracker") this._costTracker = inst;

        // Collect extra tools
        if (typeof inst.getTools === "function") {
          this._extraTools.push(...inst.getTools());
        }

        console.log(`[Extensions] ✓ ${key}`);
      } catch (err) {
        console.warn(`[Extensions] ✗ ${key}: ${err.message}`);
      }
    }

    this._initialized = true;
    const names = this._extensions.map((e) => e.constructor.name);
    console.log(
      `[Extensions] ${this._extensions.length} active — ${this._extraTools.length} extra tools registered`
    );
  }

  // ---------------------------------------------------------------------------
  // Primary hook: wraps a tool call with all extension lifecycle events
  // ---------------------------------------------------------------------------

  /**
   * executeWithExtensions(name, args, coreFn)
   *
   * @param {string}   name    Tool name
   * @param {object}   args    Tool arguments
   * @param {function} coreFn  The actual tool executor — (name, args) => result
   * @returns {*} Tool result (or approval-pending response if HITL intercepted)
   */
  async executeWithExtensions(name, args, coreFn) {
    // Build shared context object for this tool call
    const ctx = {
      id:        randomUUID(),
      name,
      args,
      startTime: Date.now(),
      // Fields set by extensions:
      _checkpointId: null,
      needsApproval: false,
      approvalResponse: null,
    };

    // --- Before hooks (run in order; short-circuit if HITL needs approval) ---
    for (const ext of this._extensions) {
      if (typeof ext.beforeToolCall === "function") {
        try {
          ext.beforeToolCall(ctx);  // intentionally synchronous-friendly
        } catch (e) {
          console.warn(`[Extensions] beforeToolCall error in ${ext.constructor.name}:`, e.message);
        }
      }
      if (ctx.needsApproval) {
        // HITL or budget block intercepted — return the approval-pending message
        return ctx.approvalResponse;
      }
    }

    // --- Execute the actual tool ---
    const execStart = Date.now();
    let result;
    try {
      result = await coreFn(name, args);
    } catch (err) {
      const durationMs = Date.now() - execStart;
      // --- Error hooks ---
      for (const ext of this._extensions) {
        if (typeof ext.onToolError === "function") {
          try { ext.onToolError(ctx, err, durationMs); }
          catch (_) { /* never let extension errors mask real errors */ }
        }
      }
      throw err;
    }

    const durationMs = Date.now() - execStart;

    // --- After hooks ---
    for (const ext of this._extensions) {
      if (typeof ext.afterToolCall === "function") {
        try { ext.afterToolCall(ctx, result, durationMs); }
        catch (e) {
          console.warn(`[Extensions] afterToolCall error in ${ext.constructor.name}:`, e.message);
        }
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Chat completion hook (called by the /chat/completions proxy)
  // ---------------------------------------------------------------------------

  /**
   * Call this after every successful AI provider response to track tokens/cost.
   *
   * @param {string} model   Model name (e.g. "gpt-4.1")
   * @param {object} usage   {prompt_tokens, completion_tokens} or {input_tokens, output_tokens}
   */
  onChatCompletion(model, usage) {
    if (!this._costTracker || !usage) return;
    try {
      const inputTokens  = usage.prompt_tokens     || usage.input_tokens     || 0;
      const outputTokens = usage.completion_tokens || usage.output_tokens    || 0;
      const costUsd      = this._costTracker.calcCost(model, inputTokens, outputTokens);
      this._costTracker.onChatCompletion(model, usage, costUsd);
    } catch (e) {
      console.warn("[Extensions] onChatCompletion error:", e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Tool registration
  // ---------------------------------------------------------------------------

  /**
   * Returns extension-contributed tools in the Ruflo tool schema format.
   * These get merged into BUILTIN_TOOLS so they appear in every tools/list.
   */
  getAdditionalTools() {
    return this._extraTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || { type: "object", properties: {} },
      // Internal marker so executeTool can route to the handler
      _extensionHandler: t._handler,
    }));
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  _loadConfig() {
    if (!existsSync(CONFIG_PATH)) {
      console.log("[Extensions] No extensions.config.json found — all extensions disabled.");
      return { extensions: {} };
    }
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (e) {
      console.warn("[Extensions] Failed to parse extensions.config.json:", e.message);
      return { extensions: {} };
    }
  }
}

// Singleton — imported and used by mcp-bridge/index.js
export const extensions = new ExtensionManager();
