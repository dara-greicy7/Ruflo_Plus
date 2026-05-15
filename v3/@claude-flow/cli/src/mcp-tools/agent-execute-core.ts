/**
 * Shared agent-execution core.
 *
 * Both the agent_execute MCP tool and the workflow runtime (G3) need
 * to dispatch a prompt to an agent's configured Anthropic model. This
 * module factors that path out so it's testable and reusable, and
 * keeps the wire from agent_spawn → ProviderManager (real) in one
 * place rather than duplicated.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectCwd } from './types.js';

const STORAGE_DIR = '.claude-flow';
const AGENT_DIR = 'agents';
const AGENT_FILE = 'store.json';

type ClaudeModel = 'haiku' | 'sonnet' | 'opus' | 'inherit';

export interface AgentRecord {
  agentId: string;
  agentType: string;
  status: 'idle' | 'busy' | 'terminated';
  health: number;
  taskCount: number;
  config: Record<string, unknown>;
  createdAt: string;
  domain?: string;
  model?: ClaudeModel;
  modelRoutedBy?: 'explicit' | 'router' | 'agent-booster' | 'default';
  lastResult?: Record<string, unknown>;
}

interface AgentStore {
  agents: Record<string, AgentRecord>;
  version: string;
}

function getAgentDir(): string { return join(getProjectCwd(), STORAGE_DIR, AGENT_DIR); }
function getAgentPath(): string { return join(getAgentDir(), AGENT_FILE); }
function ensureAgentDir(): void {
  const dir = getAgentDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
function loadAgentStore(): AgentStore {
  try {
    if (existsSync(getAgentPath())) return JSON.parse(readFileSync(getAgentPath(), 'utf-8'));
  } catch { /* fall through */ }
  return { agents: {}, version: '3.0.0' };
}
function saveAgentStore(store: AgentStore): void {
  ensureAgentDir();
  writeFileSync(getAgentPath(), JSON.stringify(store, null, 2), 'utf-8');
}

// #1906 — these were stuck on Claude-3.x ids that the Anthropic API now
// 404s. Current model ids (Claude 4.x family):
//   Opus 4.7    → claude-opus-4-7
//   Sonnet 4.6  → claude-sonnet-4-6
//   Haiku 4.5   → claude-haiku-4-5-20251001
// `inherit` and the various defaults below all map to Sonnet 4.6.
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
  inherit: DEFAULT_ANTHROPIC_MODEL,
};

export interface AnthropicCallInput {
  prompt: string;
  systemPrompt?: string;
  model?: string;          // already-resolved Anthropic model id (e.g. 'claude-sonnet-4-6')
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface AnthropicCallResult {
  success: boolean;
  model?: string;
  messageId?: string;
  stopReason?: string;
  output?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs?: number;
  error?: string;
}

/**
 * Generic Anthropic Messages API call. No agent registry coupling — used
 * by agent_execute (with the agent's configured model) and by the WASM
 * agent runtime (G4) when the bundled WASM only echoes input.
 *
 * #1725 — falls back to Ollama Cloud (Tier-2, OpenAI-compat) when
 * ANTHROPIC_API_KEY is unset and OLLAMA_API_KEY is present, or when
 * RUFLO_PROVIDER=ollama is explicitly set. Response shape is normalized
 * to the Anthropic-flavored AnthropicCallResult so existing callers
 * don't need to know which provider answered.
 */
export async function callAnthropicMessages(input: AnthropicCallInput): Promise<AnthropicCallResult> {
  const explicitProvider = (process.env.RUFLO_PROVIDER || '').toLowerCase();
  const ollamaKey = process.env.OLLAMA_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const useOllama =
    explicitProvider === 'ollama' || (!anthropicKey && !!ollamaKey);

  if (useOllama && ollamaKey) {
    return callOllamaCompat({ ...input, apiKey: ollamaKey });
  }
  if (!anthropicKey) {
    return {
      success: false,
      error:
        'No LLM provider configured. Set ANTHROPIC_API_KEY (Tier-3) or OLLAMA_API_KEY (Tier-2 Ollama Cloud — see issue #1725).',
    };
  }
  const model = input.model || DEFAULT_ANTHROPIC_MODEL;
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs || 60000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: input.maxTokens || 1024,
        temperature: typeof input.temperature === 'number' ? input.temperature : 0.7,
        ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
        messages: [{ role: 'user', content: input.prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '<unreadable error body>');
      return { success: false, model, error: `Anthropic API error ${res.status}: ${errText.slice(0, 400)}` };
    }
    const data = await res.json() as {
      id: string;
      model: string;
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    const textOut = data.content
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text as string)
      .join('');
    return {
      success: true,
      model: data.model,
      messageId: data.id,
      stopReason: data.stop_reason,
      output: textOut,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      },
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      success: false,
      model,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Ollama Cloud / OpenAI-compat provider — Tier-2 routing per ADR-026 + #1725.
 *
 * Endpoint: https://ollama.com/v1/chat/completions
 * Auth: Authorization: Bearer <OLLAMA_API_KEY>
 *
 * Translates the Anthropic-flavored input shape onto OpenAI chat-completions
 * and translates the response back so callers never see provider-specific
 * fields. Logical model names are mapped to Ollama Cloud defaults:
 *   - 'haiku'  / 'sonnet'  → 'gpt-oss:120b-cloud' (sensible single default)
 *   - 'opus'              → 'gpt-oss:120b-cloud' (no opus tier on Ollama)
 *   - explicit 'ollama:<model>' or bare provider-native name → passed through
 */
async function callOllamaCompat(
  input: AnthropicCallInput & { apiKey: string },
): Promise<AnthropicCallResult> {
  const model = resolveOllamaModel(input.model);
  const startedAt = Date.now();
  // OLLAMA_BASE_URL lets users point at local/self-hosted endpoints
  // (e.g. http://ruvultra:11434, http://localhost:11434) instead of
  // Ollama Cloud. Default is the public cloud endpoint.
  const base = (process.env.OLLAMA_BASE_URL || 'https://ollama.com').replace(/\/+$/, '');
  const url = `${base}/v1/chat/completions`;
  // Self-hosted endpoints typically don't need an Authorization header
  // (the daemon binds to 11434 with no auth by default), but Ollama Cloud
  // does. Send the bearer when the key is non-empty AND looks cloud-shaped.
  const sendAuth = input.apiKey && input.apiKey !== 'local';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs || 60000);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...(sendAuth ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: input.maxTokens || 1024,
        temperature: typeof input.temperature === 'number' ? input.temperature : 0.7,
        messages: [
          ...(input.systemPrompt
            ? [{ role: 'system' as const, content: input.systemPrompt }]
            : []),
          { role: 'user' as const, content: input.prompt },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '<unreadable error body>');
      return { success: false, model, error: `Ollama API error ${res.status} at ${url}: ${errText.slice(0, 400)}` };
    }
    const data = (await res.json()) as {
      id?: string;
      model?: string;
      choices: Array<{
        message: { role: string; content: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const textOut = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage ?? {};
    return {
      success: true,
      model: data.model ?? model,
      messageId: data.id ?? `ollama-${Date.now()}`,
      stopReason: data.choices?.[0]?.finish_reason ?? 'end_turn',
      output: textOut,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      },
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      success: false,
      model,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

function resolveOllamaModel(input: string | undefined): string {
  const DEFAULT = 'gpt-oss:120b-cloud';
  if (!input) return DEFAULT;
  // Logical → cloud default
  if (input === 'haiku' || input === 'sonnet' || input === 'opus' || input === 'inherit') {
    return DEFAULT;
  }
  // Explicit provider prefix
  if (input.startsWith('ollama:')) return input.slice('ollama:'.length);
  // Bare name with cloud suffix (e.g. 'llama3:70b-cloud') passes through
  return input;
}

/**
 * Resolve a model identifier to an Anthropic model ID. Accepts:
 * - logical names: 'haiku', 'sonnet', 'opus', 'inherit'
 * - prefixed: 'anthropic:claude-sonnet-4-6'
 * - direct: 'claude-sonnet-4-6'
 */
export function resolveAnthropicModel(input: string | undefined): string {
  if (!input) return DEFAULT_ANTHROPIC_MODEL;
  if (input in MODEL_MAP) return MODEL_MAP[input];
  if (input.startsWith('anthropic:')) return input.slice('anthropic:'.length);
  return input;
}

export interface AgentExecuteInput {
  agentId: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface AgentExecuteResult {
  success: boolean;
  agentId: string;
  model?: string;
  messageId?: string;
  stopReason?: string;
  output?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs?: number;
  error?: string;
  remediation?: string;
}

export async function executeAgentTask(input: AgentExecuteInput): Promise<AgentExecuteResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      agentId: input.agentId,
      error: 'ANTHROPIC_API_KEY not set in environment',
      remediation: 'Set the env var and re-run. The key is read at call time.',
    };
  }

  const store = loadAgentStore();
  const agent = store.agents[input.agentId];
  if (!agent) return { success: false, agentId: input.agentId, error: 'Agent not found' };
  if (agent.status === 'terminated') return { success: false, agentId: input.agentId, error: 'Agent has been terminated' };

  const anthropicModel = MODEL_MAP[agent.model || 'sonnet'] || DEFAULT_ANTHROPIC_MODEL;
  const systemPrompt = input.systemPrompt ||
    `You are a ${agent.agentType} agent operating as part of a Ruflo swarm. ` +
    `Agent ID: ${input.agentId}. Domain: ${agent.domain ?? 'general'}. ` +
    `Respond directly and stay focused on the task. If you need information you don't have, state that explicitly.`;

  agent.status = 'busy';
  agent.taskCount = (agent.taskCount || 0) + 1;
  saveAgentStore(store);

  const startedAt = Date.now();

  try {
    const controller = new AbortController();
    const timeoutMs = input.timeoutMs || 60000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: anthropicModel,
        max_tokens: input.maxTokens || 1024,
        temperature: typeof input.temperature === 'number' ? input.temperature : 0.7,
        system: systemPrompt,
        messages: [{ role: 'user', content: input.prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => '<unreadable error body>');
      agent.status = 'idle';
      saveAgentStore(store);
      return {
        success: false,
        agentId: input.agentId,
        model: anthropicModel,
        error: `Anthropic API error ${res.status}: ${errText.slice(0, 400)}`,
      };
    }

    const data = await res.json() as {
      id: string;
      model: string;
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const textOut = data.content
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text as string)
      .join('');

    const result: AgentExecuteResult = {
      success: true,
      agentId: input.agentId,
      messageId: data.id,
      model: data.model,
      stopReason: data.stop_reason,
      output: textOut,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      },
      durationMs: Date.now() - startedAt,
    };

    agent.status = 'idle';
    agent.lastResult = result as unknown as Record<string, unknown>;
    saveAgentStore(store);

    return result;
  } catch (err) {
    agent.status = 'idle';
    saveAgentStore(store);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      agentId: input.agentId,
      model: anthropicModel,
      error: `agent_execute failed: ${msg}`,
      durationMs: Date.now() - startedAt,
    };
  }
}
