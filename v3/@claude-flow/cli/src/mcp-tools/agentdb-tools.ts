/**
 * AgentDB MCP Tools — Phase 6 of ADR-053
 *
 * Exposes AgentDB v3 controller operations as MCP tools.
 * Provides direct access to ReasoningBank, CausalGraph, SkillLibrary,
 * AttestationLog, and bridge health through the MCP protocol.
 *
 * Security: All handlers validate input types, enforce length bounds,
 * and sanitize error messages before returning to MCP callers.
 *
 * @module v3/cli/mcp-tools/agentdb-tools
 */

import type { MCPTool } from './types.js';
import { validateIdentifier, validateText } from './validate-input.js';

// ===== Shared validation helpers =====

const MAX_STRING_LENGTH = 100_000; // 100KB max for any string input
const MAX_BATCH_SIZE = 500;        // Max entries per batch operation
const MAX_TOP_K = 100;             // Max results per query

function validateString(value: unknown, name: string, maxLen = MAX_STRING_LENGTH): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > maxLen) return null;
  return value;
}

function validatePositiveInt(value: unknown, defaultVal: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultVal;
  const n = Math.floor(value);
  return n > 0 ? Math.min(n, max) : defaultVal;
}

function validateScore(value: unknown, defaultVal: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultVal;
  return Math.max(0, Math.min(1, value));
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    // Strip filesystem paths from error messages
    return error.message.replace(/\/[^\s:]+\//g, '<path>/').substring(0, 500);
  }
  return 'Internal error';
}

// Lazy-cached bridge module
let bridgeModule: typeof import('../memory/memory-bridge.js') | null = null;
async function getBridge() {
  if (!bridgeModule) {
    bridgeModule = await import('../memory/memory-bridge.js');
  }
  return bridgeModule;
}

// ===== agentdb_health — Controller health check =====

export const agentdbHealth: MCPTool = {
  name: 'agentdb_health',
  description: 'Get AgentDB v3 controller health status including cache stats and attestation count Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      const health = await bridge.bridgeHealthCheck();
      if (!health) return { available: false, error: 'AgentDB bridge not available' };
      return health;
    } catch (error) {
      return { available: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_controllers — List all controllers =====

export const agentdbControllers: MCPTool = {
  name: 'agentdb_controllers',
  description: 'List all AgentDB v3 controllers and their initialization status Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      const controllers = await bridge.bridgeListControllers();
      if (!controllers) return { available: false, controllers: [], error: 'AgentDB bridge not available — @claude-flow/memory not installed or missing controller-registry. Use memory_store/memory_search tools instead.' };
      return {
        available: true,
        controllers,
        total: controllers.length,
        active: controllers.filter((c: any) => c.enabled).length,
      };
    } catch (error) {
      return { available: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_pattern_store — Store via ReasoningBank =====

export const agentdbPatternStore: MCPTool = {
  name: 'agentdb_pattern-store',
  description: 'Store a pattern directly via ReasoningBank controller Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Pattern description' },
      type: { type: 'string', description: 'Pattern type (e.g., task-routing, error-recovery)' },
      confidence: { type: 'number', description: 'Confidence score (0-1)' },
    },
    required: ['pattern'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vPattern = validateText(params.pattern, 'pattern', 100_000);
      if (!vPattern.valid) return { success: false, error: vPattern.error };
      if (params.type) { const vType = validateIdentifier(params.type, 'type'); if (!vType.valid) return { success: false, error: vType.error }; }
      const pattern = validateString(params.pattern, 'pattern');
      if (!pattern) return { success: false, error: 'pattern is required (non-empty string, max 100KB)' };
      const type = validateString(params.type, 'type', 200) ?? 'general';
      const confidence = validateScore(params.confidence, 0.8);

      const bridge = await getBridge();
      const result = await bridge.bridgeStorePattern({ pattern, type, confidence });
      if (result) return result;

      // ADR-093 F4: when the ReasoningBank controller registry returns
      // null (the cause of audit-reported "AgentDB bridge not available"
      // even though `agentdb_health.reasoningBank.enabled === true`), fall
      // back to a direct memory_store write so the caller's pattern still
      // persists. Surface the controller as `memory-store-fallback` so the
      // path is observable instead of silently lost.
      try {
        const { storeEntry } = await import('../memory/memory-initializer.js');
        const patternId = `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const value = JSON.stringify({ pattern, type, confidence, _fallback: 'reasoningBank-unavailable' });
        await storeEntry({
          key: patternId,
          value,
          namespace: 'pattern',
          tags: [type, 'reasoning-pattern', 'fallback'],
        });
        return {
          success: true,
          patternId,
          controller: 'memory-store-fallback',
          note: 'ReasoningBank controller registry unavailable. Pattern persisted via memory_store. Run `agentdb_health` to inspect controller registration.',
        };
      } catch (fallbackErr) {
        return {
          success: false,
          error: 'Pattern store failed: both ReasoningBank bridge and memory_store fallback unavailable',
          fallbackError: sanitizeError(fallbackErr),
          recommendation: 'Run agentdb_health to inspect controller registration and check that .swarm/memory.db is writable.',
        };
      }
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_pattern_search — Search via ReasoningBank =====

export const agentdbPatternSearch: MCPTool = {
  name: 'agentdb_pattern-search',
  description: 'Search patterns via ReasoningBank controller with BM25+semantic hybrid Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      topK: { type: 'number', description: 'Number of results (default: 5)' },
      minConfidence: { type: 'number', description: 'Minimum score threshold (0-1)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vQuery = validateText(params.query, 'query', 10_000);
      if (!vQuery.valid) return { results: [], error: vQuery.error };
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { results: [], error: 'query is required (non-empty string, max 10KB)' };
      const topK = validatePositiveInt(params.topK, 5, MAX_TOP_K);
      const minConfidence = validateScore(params.minConfidence, 0.3);

      const bridge = await getBridge();
      const result = await bridge.bridgeSearchPatterns({ query, topK, minConfidence });
      if (result && Array.isArray(result.results) && result.results.length > 0) {
        return result;
      }

      // #1889 — symmetric fallback. pattern-store writes to the `pattern`
      // namespace via memory_store when ReasoningBank is unavailable; the
      // search path used to return an empty list with `controller: 'unavailable'`
      // even though the user's pattern was sitting in that namespace. We now
      // tier the fallback so freshly-written entries are findable before HNSW
      // catches up:
      //   1. Try semantic search via searchEntries (HNSW-backed)
      //   2. If that returns 0, list the namespace and substring-match the query
      //      against each entry's pattern text. Deterministic; survives
      //      embedding-index latency and threshold tuning.
      try {
        const { searchEntries, listEntries } = await import('../memory/memory-initializer.js');

        const parseEntry = (e: Record<string, unknown>): Record<string, unknown> | null => {
          const raw = typeof e.content === 'string' ? e.content : (e as { value?: unknown }).value;
          if (typeof raw !== 'string') return null;
          try {
            const parsed = JSON.parse(raw);
            const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.8;
            if (confidence < minConfidence) return null;
            return {
              patternId: e.key ?? e.id,
              pattern: parsed.pattern,
              type: parsed.type ?? 'general',
              confidence,
              score: typeof e.score === 'number' ? e.score : undefined,
            };
          } catch {
            return null;
          }
        };

        // Tier 1 — semantic
        let results: Array<Record<string, unknown>> = [];
        let tier: 'semantic' | 'substring' = 'semantic';
        try {
          const semantic = await searchEntries({ query, namespace: 'pattern', limit: topK });
          results = (semantic?.results ?? [])
            .map(parseEntry)
            .filter((r): r is Record<string, unknown> => r !== null);
        } catch { /* fall through to tier 2 */ }

        // Tier 2 — substring scan (catches just-written entries before HNSW indexes them)
        if (results.length === 0) {
          tier = 'substring';
          const all = await listEntries({ namespace: 'pattern', limit: 200 });
          const qLower = query.toLowerCase();
          const matched: Array<Record<string, unknown>> = [];
          for (const e of (all?.entries ?? [])) {
            const parsed = parseEntry(e as Record<string, unknown>);
            if (!parsed) continue;
            const text = typeof parsed.pattern === 'string' ? parsed.pattern.toLowerCase() : '';
            if (text.includes(qLower)) matched.push(parsed);
            if (matched.length >= topK) break;
          }
          results = matched;
        }

        // #1889 — controller label must match pattern-store's so the smoke
        // round-trip sees both ends agree. The store reports
        // `memory-store-fallback`; we use the same name + a `tier` field
        // to expose which sub-strategy fired.
        return {
          results,
          controller: 'memory-store-fallback',
          tier,
          note: result
            ? `ReasoningBank returned 0 results; tier=${tier} from pattern namespace.`
            : `ReasoningBank controller unavailable; tier=${tier} from pattern namespace.`,
        };
      } catch (fallbackErr) {
        return { results: [], controller: 'unavailable', fallbackError: sanitizeError(fallbackErr) };
      }
    } catch (error) {
      return { results: [], error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_feedback — Record task feedback =====

export const agentdbFeedback: MCPTool = {
  name: 'agentdb_feedback',
  description: 'Record task feedback for learning via LearningSystem + ReasoningBank controllers Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task identifier' },
      success: { type: 'boolean', description: 'Whether task succeeded' },
      quality: { type: 'number', description: 'Quality score (0-1)' },
      agent: { type: 'string', description: 'Agent that performed the task' },
    },
    required: ['taskId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vTaskId = validateIdentifier(params.taskId, 'taskId');
      if (!vTaskId.valid) return { success: false, error: vTaskId.error };
      if (params.agent) { const vAgent = validateIdentifier(params.agent, 'agent'); if (!vAgent.valid) return { success: false, error: vAgent.error }; }
      const taskId = validateString(params.taskId, 'taskId', 500);
      if (!taskId) return { success: false, error: 'taskId is required (non-empty string, max 500 chars)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeRecordFeedback({
        taskId,
        success: params.success === true,
        quality: validateScore(params.quality, 0.85),
        agent: validateString(params.agent, 'agent', 200) ?? undefined,
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_causal_edge — Record causal relationships =====

export const agentdbCausalEdge: MCPTool = {
  name: 'agentdb_causal-edge',
  description: 'Record a causal edge between two memory entries via CausalMemoryGraph Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'Source entry ID' },
      targetId: { type: 'string', description: 'Target entry ID' },
      relation: { type: 'string', description: 'Relationship type (e.g., caused, preceded, succeeded)' },
      weight: { type: 'number', description: 'Edge weight (0-1)' },
    },
    required: ['sourceId', 'targetId', 'relation'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vSourceId = validateIdentifier(params.sourceId, 'sourceId');
      if (!vSourceId.valid) return { success: false, error: vSourceId.error };
      const vTargetId = validateIdentifier(params.targetId, 'targetId');
      if (!vTargetId.valid) return { success: false, error: vTargetId.error };
      const vRelation = validateIdentifier(params.relation, 'relation');
      if (!vRelation.valid) return { success: false, error: vRelation.error };
      const sourceId = validateString(params.sourceId, 'sourceId', 500);
      const targetId = validateString(params.targetId, 'targetId', 500);
      const relation = validateString(params.relation, 'relation', 200);
      if (!sourceId) return { success: false, error: 'sourceId is required (non-empty string)' };
      if (!targetId) return { success: false, error: 'targetId is required (non-empty string)' };
      if (!relation) return { success: false, error: 'relation is required (non-empty string)' };
      // Try native graph-node backend first (ADR-087)
      try {
        const graphBackend = await import('../ruvector/graph-backend.js');
        if (await graphBackend.isGraphBackendAvailable()) {
          const graphResult = await graphBackend.recordCausalEdge(
            sourceId, targetId, relation,
            typeof params.weight === 'number' ? validateScore(params.weight, 0.5) : undefined,
          );
          if (graphResult.success) {
            // Also record in AgentDB bridge for compatibility
            const bridge = await getBridge();
            await bridge.bridgeRecordCausalEdge({ sourceId, targetId, relation, weight: typeof params.weight === 'number' ? validateScore(params.weight, 0.5) : undefined }).catch(() => {});
            return { ...graphResult, _graphNodeBackend: true };
          }
        }
      } catch { /* graph-node not available, fall through */ }

      const bridge = await getBridge();
      const result = await bridge.bridgeRecordCausalEdge({
        sourceId,
        targetId,
        relation,
        weight: typeof params.weight === 'number' ? validateScore(params.weight, 0.5) : undefined,
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_route — Route via SemanticRouter =====

export const agentdbRoute: MCPTool = {
  name: 'agentdb_route',
  description: 'Route a task via AgentDB SemanticRouter or LearningSystem recommendAlgorithm Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description to route' },
      context: { type: 'string', description: 'Additional context' },
    },
    required: ['task'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vTask = validateText(params.task, 'task', 10_000);
      if (!vTask.valid) return { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'error', error: vTask.error };
      if (params.context) { const vCtx = validateText(params.context, 'context', 10_000); if (!vCtx.valid) return { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'error', error: vCtx.error }; }
      const task = validateString(params.task, 'task', 10_000);
      if (!task) return { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'error', error: 'task is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeRouteTask({
        task,
        context: validateString(params.context, 'context', 10_000) ?? undefined,
      });
      return result ?? { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'fallback' };
    } catch (error) {
      return { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'error', error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_session_start — Session with ReflexionMemory =====

export const agentdbSessionStart: MCPTool = {
  name: 'agentdb_session-start',
  description: 'Start a session with ReflexionMemory episodic replay Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session identifier' },
      context: { type: 'string', description: 'Session context for pattern retrieval' },
    },
    required: ['sessionId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vSessionId = validateIdentifier(params.sessionId, 'sessionId');
      if (!vSessionId.valid) return { success: false, error: vSessionId.error };
      if (params.context) { const vCtx = validateText(params.context, 'context', 10_000); if (!vCtx.valid) return { success: false, error: vCtx.error }; }
      const sessionId = validateString(params.sessionId, 'sessionId', 500);
      if (!sessionId) return { success: false, error: 'sessionId is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSessionStart({
        sessionId,
        context: validateString(params.context, 'context', 10_000) ?? undefined,
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_session_end — End session + NightlyLearner =====

export const agentdbSessionEnd: MCPTool = {
  name: 'agentdb_session-end',
  description: 'End session, persist to ReflexionMemory, trigger NightlyLearner consolidation Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session identifier' },
      summary: { type: 'string', description: 'Session summary' },
      tasksCompleted: { type: 'number', description: 'Number of tasks completed' },
    },
    required: ['sessionId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vSessionId = validateIdentifier(params.sessionId, 'sessionId');
      if (!vSessionId.valid) return { success: false, error: vSessionId.error };
      if (params.summary) { const vSummary = validateText(params.summary, 'summary', 50_000); if (!vSummary.valid) return { success: false, error: vSummary.error }; }
      const sessionId = validateString(params.sessionId, 'sessionId', 500);
      if (!sessionId) return { success: false, error: 'sessionId is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSessionEnd({
        sessionId,
        summary: validateString(params.summary, 'summary', 50_000) ?? undefined,
        tasksCompleted: validatePositiveInt(params.tasksCompleted, 0, 10_000),
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_hierarchical_store — Store to hierarchical memory =====

export const agentdbHierarchicalStore: MCPTool = {
  name: 'agentdb_hierarchical-store',
  description: 'Store to hierarchical memory with tier (working, episodic, semantic) Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Memory entry key' },
      value: { type: 'string', description: 'Memory entry value' },
      tier: {
        type: 'string',
        description: 'Memory tier (working, episodic, semantic)',
        enum: ['working', 'episodic', 'semantic'],
        default: 'working',
      },
    },
    required: ['key', 'value'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vKey = validateIdentifier(params.key, 'key');
      if (!vKey.valid) return { success: false, error: vKey.error };
      const vValue = validateText(params.value, 'value');
      if (!vValue.valid) return { success: false, error: vValue.error };
      if (params.tier) { const vTier = validateIdentifier(params.tier, 'tier'); if (!vTier.valid) return { success: false, error: vTier.error }; }
      const key = validateString(params.key, 'key', 1000);
      const value = validateString(params.value, 'value');
      if (!key) return { success: false, error: 'key is required (non-empty string, max 1KB)' };
      if (!value) return { success: false, error: 'value is required (non-empty string, max 100KB)' };
      const tier = validateString(params.tier, 'tier', 20) ?? 'working';
      if (!['working', 'episodic', 'semantic'].includes(tier)) {
        return { success: false, error: `Invalid tier: ${tier}. Must be working, episodic, or semantic` };
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeHierarchicalStore({ key, value, tier });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_hierarchical_recall — Recall from hierarchical memory =====

export const agentdbHierarchicalRecall: MCPTool = {
  name: 'agentdb_hierarchical-recall',
  description: 'Recall from hierarchical memory with optional tier filter Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Recall query' },
      tier: { type: 'string', description: 'Filter by tier (working, episodic, semantic)' },
      topK: { type: 'number', description: 'Number of results (default: 5)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vQuery = validateText(params.query, 'query', 10_000);
      if (!vQuery.valid) return { results: [], error: vQuery.error };
      if (params.tier) { const vTier = validateIdentifier(params.tier, 'tier'); if (!vTier.valid) return { results: [], error: vTier.error }; }
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { results: [], error: 'query is required (non-empty string, max 10KB)' };
      const tier = validateString(params.tier, 'tier', 20);
      if (tier && !['working', 'episodic', 'semantic'].includes(tier)) {
        return { results: [], error: `Invalid tier: ${tier}. Must be working, episodic, or semantic` };
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeHierarchicalRecall({
        query,
        tier: tier ?? undefined,
        topK: validatePositiveInt(params.topK, 5, MAX_TOP_K),
      });
      return result ?? { results: [], error: 'AgentDB bridge not available. Use memory_search instead.' };
    } catch (error) {
      return { results: [], error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_consolidate — Run memory consolidation =====

export const agentdbConsolidate: MCPTool = {
  name: 'agentdb_consolidate',
  description: 'Run memory consolidation to promote entries across tiers and compress old data Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      minAge: { type: 'number', description: 'Minimum age in hours since store (optional)' },
      maxEntries: { type: 'number', description: 'Maximum entries to consolidate (optional)' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const bridge = await getBridge();
      const result = await bridge.bridgeConsolidate({
        minAge: typeof params.minAge === 'number' ? Math.max(0, params.minAge) : undefined,
        maxEntries: validatePositiveInt(params.maxEntries, 1000, 10_000),
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_batch — Batch operations (insert, update, delete) =====

export const agentdbBatch: MCPTool = {
  name: 'agentdb_batch',
  description: 'Batch operations on AgentDB episodes (insert, update, delete). Note: entries are stored in the AgentDB episodes table, not the memory_search namespace. Use memory_store for entries that should be searchable via memory_search. Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        description: 'Batch operation type',
        enum: ['insert', 'update', 'delete'],
      },
      entries: {
        type: 'array',
        description: 'Array of {key, value} entries to operate on',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['key'],
        },
      },
    },
    required: ['operation', 'entries'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vOp = validateIdentifier(params.operation, 'operation');
      if (!vOp.valid) return { success: false, error: vOp.error };
      const operation = validateString(params.operation, 'operation', 20);
      if (!operation) return { success: false, error: 'operation is required (string)' };
      if (!['insert', 'update', 'delete'].includes(operation)) {
        return { success: false, error: `Invalid operation: ${operation}. Must be insert, update, or delete` };
      }
      if (!Array.isArray(params.entries) || params.entries.length === 0) {
        return { success: false, error: 'entries is required (non-empty array)' };
      }
      if (params.entries.length > MAX_BATCH_SIZE) {
        return { success: false, error: `Too many entries: ${params.entries.length}. Max is ${MAX_BATCH_SIZE}` };
      }
      // Validate each entry
      const validatedEntries: Array<{ key: string; value?: string; metadata?: Record<string, unknown> }> = [];
      for (let i = 0; i < params.entries.length; i++) {
        const entry = params.entries[i];
        if (!entry || typeof entry !== 'object') {
          return { success: false, error: `entries[${i}] must be an object` };
        }
        const key = validateString((entry as any).key, `entries[${i}].key`, 1000);
        if (!key) return { success: false, error: `entries[${i}].key is required (non-empty string)` };
        const value = validateString((entry as any).value, `entries[${i}].value`);
        validatedEntries.push({ key, value: value ?? undefined });
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeBatchOperation({
        operation,
        entries: validatedEntries,
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_context_synthesize — Synthesize context from memories =====

export const agentdbContextSynthesize: MCPTool = {
  name: 'agentdb_context-synthesize',
  description: 'Synthesize context from stored memories for a given query Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Query to synthesize context for' },
      maxEntries: { type: 'number', description: 'Maximum entries to include (default: 10)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vQuery = validateText(params.query, 'query', 10_000);
      if (!vQuery.valid) return { success: false, error: vQuery.error };
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { success: false, error: 'query is required (non-empty string, max 10KB)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeContextSynthesize({
        query,
        maxEntries: validatePositiveInt(params.maxEntries, 10, MAX_TOP_K),
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_semantic_route — Route via SemanticRouter =====

export const agentdbSemanticRoute: MCPTool = {
  name: 'agentdb_semantic-route',
  description: 'Route an input via AgentDB SemanticRouter for intent classification Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input text to route' },
    },
    required: ['input'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vInput = validateText(params.input, 'input', 10_000);
      if (!vInput.valid) return { route: null, error: vInput.error };
      const input = validateString(params.input, 'input', 10_000);
      if (!input) return { route: null, error: 'input is required (non-empty string, max 10KB)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSemanticRoute({ input });
      return result ?? { route: null, error: 'AgentDB bridge not available. Use hooks route instead.' };
    } catch (error) {
      return { route: null, error: sanitizeError(error) };
    }
  },
};

// ===== #1784: Delete tools — symmetry for hierarchical-store + causal-edge =====

export const agentdbHierarchicalDelete: MCPTool = {
  name: 'agentdb_hierarchical-delete',
  description: 'Delete a hierarchical-memory entry by key. Returns controller="native-unsupported" when the entry is in a backend without a public delete API. Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Memory entry key to delete' },
      tier: {
        type: 'string',
        description: 'Optional tier filter (working, episodic, semantic)',
        enum: ['working', 'episodic', 'semantic'],
      },
    },
    required: ['key'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vKey = validateIdentifier(params.key, 'key');
      if (!vKey.valid) return { success: false, deleted: false, error: vKey.error };
      if (params.tier) { const vTier = validateIdentifier(params.tier, 'tier'); if (!vTier.valid) return { success: false, deleted: false, error: vTier.error }; }
      const key = validateString(params.key, 'key', 1000);
      if (!key) return { success: false, deleted: false, error: 'key is required (non-empty string, max 1KB)' };
      const tier = validateString(params.tier, 'tier', 20);
      if (tier && !['working', 'episodic', 'semantic'].includes(tier)) {
        return { success: false, deleted: false, error: `Invalid tier: ${tier}. Must be working, episodic, or semantic` };
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeDeleteHierarchical({ key, tier: tier ?? undefined });
      return result ?? { success: false, deleted: false, error: 'AgentDB bridge not available' };
    } catch (error) {
      return { success: false, deleted: false, error: sanitizeError(error) };
    }
  },
};

export const agentdbCausalEdgeDelete: MCPTool = {
  name: 'agentdb_causal-edge-delete',
  description: 'Delete a causal edge between two memory entries. Returns controller="native-unsupported" when the edge lives in graph-node native storage (no public delete API). Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'Source entry ID' },
      targetId: { type: 'string', description: 'Target entry ID' },
      relation: { type: 'string', description: 'Optional relationship type filter' },
    },
    required: ['sourceId', 'targetId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vSourceId = validateIdentifier(params.sourceId, 'sourceId');
      if (!vSourceId.valid) return { success: false, deleted: false, error: vSourceId.error };
      const vTargetId = validateIdentifier(params.targetId, 'targetId');
      if (!vTargetId.valid) return { success: false, deleted: false, error: vTargetId.error };
      const sourceId = validateString(params.sourceId, 'sourceId', 500);
      const targetId = validateString(params.targetId, 'targetId', 500);
      if (!sourceId) return { success: false, deleted: false, error: 'sourceId is required (non-empty string)' };
      if (!targetId) return { success: false, deleted: false, error: 'targetId is required (non-empty string)' };
      const relation = validateString(params.relation, 'relation', 200) ?? undefined;
      const bridge = await getBridge();
      const result = await bridge.bridgeDeleteCausalEdge({ sourceId, targetId, relation });
      return result ?? { success: false, deleted: false, error: 'AgentDB bridge not available' };
    } catch (error) {
      return { success: false, deleted: false, error: sanitizeError(error) };
    }
  },
};

export const agentdbCausalNodeDelete: MCPTool = {
  name: 'agentdb_causal-node-delete',
  description: 'Cascade-delete a causal node and all its incident edges from the SQL fallback. Native graph-node entries are unaffected (no delete API in the binding). Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID to delete (cascades to all incident edges)' },
    },
    required: ['nodeId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vNodeId = validateIdentifier(params.nodeId, 'nodeId');
      if (!vNodeId.valid) return { success: false, deletedNode: false, deletedEdges: 0, error: vNodeId.error };
      const nodeId = validateString(params.nodeId, 'nodeId', 500);
      if (!nodeId) return { success: false, deletedNode: false, deletedEdges: 0, error: 'nodeId is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeDeleteCausalNode({ nodeId });
      return result ?? { success: false, deletedNode: false, deletedEdges: 0, error: 'AgentDB bridge not available' };
    } catch (error) {
      return { success: false, deletedNode: false, deletedEdges: 0, error: sanitizeError(error) };
    }
  },
};

// ===== Export all tools =====

export const agentdbTools: MCPTool[] = [
  agentdbHealth,
  agentdbControllers,
  agentdbPatternStore,
  agentdbPatternSearch,
  agentdbFeedback,
  agentdbCausalEdge,
  agentdbCausalEdgeDelete,
  agentdbCausalNodeDelete,
  agentdbRoute,
  agentdbSessionStart,
  agentdbSessionEnd,
  agentdbHierarchicalStore,
  agentdbHierarchicalRecall,
  agentdbHierarchicalDelete,
  agentdbConsolidate,
  agentdbBatch,
  agentdbContextSynthesize,
  agentdbSemanticRoute,
];
