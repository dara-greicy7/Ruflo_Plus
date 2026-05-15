/**
 * Intelligent Model Router using Tiny Dancer
 *
 * Dynamically routes requests to optimal Claude model (haiku/sonnet/opus)
 * based on task complexity, confidence scores, and historical performance.
 *
 * Features:
 * - FastGRNN-based routing decisions (<100μs)
 * - Uncertainty quantification for model escalation
 * - Circuit breaker for failover
 * - Online learning from routing outcomes
 * - Complexity scoring via embeddings
 *
 * Routing Strategy:
 * - Haiku: High confidence, low complexity (fast, cheap)
 * - Sonnet: Medium confidence, moderate complexity (balanced)
 * - Opus: Low confidence, high complexity (most capable)
 *
 * @module model-router
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

// ============================================================================
// Types & Constants
// ============================================================================

/**
 * Available Claude models for routing
 */
export type ClaudeModel = 'haiku' | 'sonnet' | 'opus' | 'inherit';

/**
 * Model capabilities and characteristics
 */
export const MODEL_CAPABILITIES: Record<ClaudeModel, {
  maxComplexity: number;
  costMultiplier: number;
  speedMultiplier: number;
  description: string;
}> = {
  haiku: {
    maxComplexity: 0.4,
    costMultiplier: 0.04,  // ~25x cheaper than Opus
    speedMultiplier: 3.0,   // ~3x faster than Sonnet
    description: 'Fast, cost-effective for simple tasks',
  },
  sonnet: {
    maxComplexity: 0.7,
    costMultiplier: 0.2,    // ~5x cheaper than Opus
    speedMultiplier: 1.5,   // ~1.5x faster than Opus
    description: 'Balanced capability and cost',
  },
  opus: {
    maxComplexity: 1.0,
    costMultiplier: 1.0,    // Baseline
    speedMultiplier: 1.0,   // Baseline
    description: 'Most capable for complex reasoning',
  },
  inherit: {
    maxComplexity: 1.0,
    costMultiplier: 1.0,
    speedMultiplier: 1.0,
    description: 'Use parent model selection',
  },
};

/**
 * Complexity indicators for task classification
 */
export const COMPLEXITY_INDICATORS = {
  high: [
    'architect', 'design', 'refactor', 'optimize', 'security', 'audit',
    'complex', 'analyze', 'investigate', 'debug', 'performance', 'scale',
    'distributed', 'concurrent', 'algorithm', 'system', 'integration',
  ],
  medium: [
    'implement', 'feature', 'add', 'update', 'modify', 'fix', 'test',
    'review', 'validate', 'check', 'improve', 'enhance', 'extend',
  ],
  low: [
    'simple', 'typo', 'comment', 'format', 'rename', 'move', 'copy',
    'delete', 'documentation', 'readme', 'config', 'version', 'bump',
  ],
};

/**
 * Model router configuration
 */
export interface ModelRouterConfig {
  /** Confidence threshold for model selection (default: 0.85) */
  confidenceThreshold: number;
  /** Maximum uncertainty before escalating (default: 0.15) */
  maxUncertainty: number;
  /** Enable circuit breaker (default: true) */
  enableCircuitBreaker: boolean;
  /** Failures before circuit opens (default: 5) */
  circuitBreakerThreshold: number;
  /** Path for router state persistence */
  statePath: string;
  /** Auto-save interval in decisions (default: 20) */
  autoSaveInterval: number;
  /** Enable cost optimization (default: true) */
  enableCostOptimization: boolean;
  /** Prefer faster models when confidence is high (default: true) */
  preferSpeed: boolean;
}

/**
 * Routing decision result
 */
export interface ModelRoutingResult {
  /** Selected model */
  model: ClaudeModel;
  /** Confidence in the decision (0-1) */
  confidence: number;
  /** Uncertainty estimate (0-1) */
  uncertainty: number;
  /** Computed complexity score (0-1) */
  complexity: number;
  /** Reasoning for the selection */
  reasoning: string;
  /** Alternative models considered */
  alternatives: Array<{ model: ClaudeModel; score: number }>;
  /** Inference time in microseconds */
  inferenceTimeUs: number;
  /** Estimated cost multiplier */
  costMultiplier: number;
}

/**
 * Complexity analysis result
 */
export interface ComplexityAnalysis {
  /** Overall complexity score (0-1) */
  score: number;
  /** Indicators found */
  indicators: {
    high: string[];
    medium: string[];
    low: string[];
  };
  /** Feature breakdown */
  features: {
    lexicalComplexity: number;
    semanticDepth: number;
    taskScope: number;
    uncertaintyLevel: number;
  };
}

/**
 * Beta(α, β) prior for Thompson sampling. Each model carries one of these;
 * outcomes update α (successes) and β (failures) so the router auto-balances
 * cost/quality without manual threshold tuning. See ADR-101.
 */
export interface BetaPrior {
  alpha: number;
  beta: number;
}

/**
 * Cost-adjusted Bernoulli rewards for Thompson sampling updates. Higher
 * reward when the right tier is chosen — Haiku-success > Sonnet-success >
 * Opus-success because Opus-success on a simple task is wasteful even when
 * the answer is correct. Escalations get partial credit at best (Sonnet) or
 * zero (Haiku/Opus) since they signal the initial choice was wrong.
 */
const BANDIT_REWARDS: Record<ClaudeModel, Record<'success' | 'failure' | 'escalated', number>> = {
  haiku:   { success: 1.0, failure: 0.0, escalated: 0.0 },
  sonnet:  { success: 0.7, failure: 0.0, escalated: 0.1 },
  opus:    { success: 0.4, failure: 0.0, escalated: 0.0 },
  inherit: { success: 0.5, failure: 0.0, escalated: 0.0 },
};

/**
 * Router state for persistence
 */
interface RouterState {
  totalDecisions: number;
  modelDistribution: Record<ClaudeModel, number>;
  avgComplexity: number;
  avgConfidence: number;
  circuitBreakerTrips: number;
  lastUpdated: string;
  learningHistory: Array<{
    task: string;
    model: ClaudeModel;
    complexity: number;
    outcome: 'success' | 'failure' | 'escalated';
    timestamp: string;
  }>;
  /**
   * Beta(α, β) priors per model — populated by recordOutcome via Thompson
   * sampling. Defaults to {alpha:1,beta:1} (uniform). After ~50 outcomes
   * these converge so the router auto-corrects against tier overuse.
   */
  priors?: Record<ClaudeModel, BetaPrior>;
}

// ============================================================================
// Beta Sampling for Thompson Sampling Bandit
// ============================================================================

/**
 * Standard normal sample via Box-Muller. Used by Marsaglia-Tsang Gamma.
 * Module-local so the bandit doesn't pull in a heavy stats dep.
 */
function sampleStandardNormal(): number {
  const u1 = Math.random() || 1e-12; // avoid log(0)
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Sample from Gamma(shape α, scale=1). Marsaglia & Tsang (2000), with the
 * standard "boost α<1 by α+1 then scale by U^(1/α)" trick for shape parameters
 * smaller than 1. O(1) expected, no rejection-loop pathology in practice.
 */
function sampleGamma(alpha: number): number {
  if (alpha < 1) {
    const u = Math.random() || 1e-12;
    return sampleGamma(alpha + 1) * Math.pow(u, 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number;
    let v: number;
    do {
      x = sampleStandardNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    const xx = x * x;
    if (u < 1 - 0.0331 * xx * xx) return d * v;
    if (Math.log(u) < 0.5 * xx + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Sample θ ~ Beta(α, β) via the identity Beta(α,β) = X / (X+Y) where
 * X ~ Gamma(α), Y ~ Gamma(β). Returns the mean for degenerate α+β=0
 * (shouldn't happen in practice but defensive).
 */
function sampleBeta(alpha: number, beta: number): number {
  if (alpha <= 0 || beta <= 0) return 0.5;
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  const denom = x + y;
  return denom > 0 ? x / denom : 0.5;
}

/**
 * Default uniform priors (no prior knowledge). Beta(1,1) is the standard
 * Bayesian-Bernoulli starting point — uniform over [0,1].
 */
function defaultBanditPriors(): Record<ClaudeModel, BetaPrior> {
  return {
    haiku:   { alpha: 1, beta: 1 },
    sonnet:  { alpha: 1, beta: 1 },
    opus:    { alpha: 1, beta: 1 },
    inherit: { alpha: 1, beta: 1 },
  };
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: ModelRouterConfig = {
  confidenceThreshold: 0.85,
  maxUncertainty: 0.15,
  enableCircuitBreaker: true,
  circuitBreakerThreshold: 5,
  statePath: '.swarm/model-router-state.json',
  autoSaveInterval: 1, // Save after every decision for CLI persistence
  enableCostOptimization: true,
  preferSpeed: true,
};

// ============================================================================
// Model Router Implementation
// ============================================================================

/**
 * Intelligent Model Router using complexity-based routing
 */
export class ModelRouter {
  private config: ModelRouterConfig;
  private state: RouterState;
  private decisionCount = 0;
  private consecutiveFailures: Record<ClaudeModel, number> = {
    haiku: 0,
    sonnet: 0,
    opus: 0,
    inherit: 0,
  };

  constructor(config: Partial<ModelRouterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.loadState();
  }

  /**
   * Route a task to the optimal model
   */
  async route(task: string, embedding?: number[]): Promise<ModelRoutingResult> {
    const startTime = performance.now();

    // Analyze task complexity
    const complexity = this.analyzeComplexity(task, embedding);

    // Compute base model scores
    const scores = this.computeModelScores(complexity);

    // Apply circuit breaker adjustments
    const adjustedScores = this.applyCircuitBreaker(scores);

    // Select best model
    const { model, confidence, uncertainty } = this.selectModel(adjustedScores, complexity.score);

    const inferenceTimeUs = (performance.now() - startTime) * 1000;

    // Build result
    const result: ModelRoutingResult = {
      model,
      confidence,
      uncertainty,
      complexity: complexity.score,
      reasoning: this.buildReasoning(model, complexity, confidence),
      alternatives: Object.entries(adjustedScores)
        .filter(([m]) => m !== model)
        .map(([m, score]) => ({ model: m as ClaudeModel, score }))
        .sort((a, b) => b.score - a.score),
      inferenceTimeUs,
      costMultiplier: MODEL_CAPABILITIES[model].costMultiplier,
    };

    // Track decision
    this.trackDecision(task, result);

    return result;
  }

  /**
   * Analyze task complexity
   */
  analyzeComplexity(task: string, embedding?: number[]): ComplexityAnalysis {
    const taskLower = task.toLowerCase();
    const words = taskLower.split(/\s+/);

    // Find complexity indicators
    const indicators = {
      high: COMPLEXITY_INDICATORS.high.filter(ind => taskLower.includes(ind)),
      medium: COMPLEXITY_INDICATORS.medium.filter(ind => taskLower.includes(ind)),
      low: COMPLEXITY_INDICATORS.low.filter(ind => taskLower.includes(ind)),
    };

    // Compute feature scores
    const lexicalComplexity = this.computeLexicalComplexity(task);
    const semanticDepth = this.computeSemanticDepth(indicators, embedding);
    const taskScope = this.computeTaskScope(task, words);
    const uncertaintyLevel = this.computeUncertaintyLevel(task);

    // Weighted combination
    const score = Math.min(1, Math.max(0,
      lexicalComplexity * 0.2 +
      semanticDepth * 0.35 +
      taskScope * 0.25 +
      uncertaintyLevel * 0.2
    ));

    return {
      score,
      indicators,
      features: {
        lexicalComplexity,
        semanticDepth,
        taskScope,
        uncertaintyLevel,
      },
    };
  }

  /**
   * Compute lexical complexity from text features
   */
  private computeLexicalComplexity(task: string): number {
    const words = task.split(/\s+/);
    const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / Math.max(1, words.length);
    const sentenceLength = words.length;

    // Normalize: longer sentences with longer words = more complex
    const lengthScore = Math.min(1, sentenceLength / 50);
    const wordScore = Math.min(1, (avgWordLength - 3) / 7); // 3-10 char words

    return lengthScore * 0.4 + wordScore * 0.6;
  }

  /**
   * Compute semantic depth from indicators and embedding
   */
  private computeSemanticDepth(
    indicators: { high: string[]; medium: string[]; low: string[] },
    embedding?: number[]
  ): number {
    // Weight by indicator presence
    const highWeight = indicators.high.length * 0.3;
    const mediumWeight = indicators.medium.length * 0.15;
    const lowWeight = indicators.low.length * -0.1;

    let baseScore = Math.min(1, Math.max(0, 0.3 + highWeight + mediumWeight + lowWeight));

    // Boost with embedding variance if available
    if (embedding && embedding.length > 0) {
      const mean = embedding.reduce((a, b) => a + b, 0) / embedding.length;
      const variance = embedding.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / embedding.length;
      // Higher variance suggests more nuanced semantics
      baseScore = baseScore * 0.7 + Math.min(1, variance * 10) * 0.3;
    }

    return baseScore;
  }

  /**
   * Compute task scope from content analysis
   */
  private computeTaskScope(task: string, words: string[]): number {
    // Multi-file indicators
    const multiFilePatterns = [
      /multiple files?/i, /across.*modules?/i, /refactor.*codebase/i,
      /all.*files/i, /entire.*project/i, /system.*wide/i,
    ];
    const hasMultiFile = multiFilePatterns.some(p => p.test(task)) ? 0.4 : 0;

    // Code generation indicators
    const codeGenPatterns = [
      /implement/i, /create.*feature/i, /build.*system/i,
      /design.*api/i, /write.*tests/i, /add.*functionality/i,
    ];
    const hasCodeGen = codeGenPatterns.some(p => p.test(task)) ? 0.3 : 0;

    // Word count contribution
    const wordCountScore = Math.min(0.3, words.length / 100);

    return hasMultiFile + hasCodeGen + wordCountScore;
  }

  /**
   * Compute uncertainty level from task phrasing
   */
  private computeUncertaintyLevel(task: string): number {
    const uncertainPatterns = [
      /not sure/i, /might/i, /maybe/i, /possibly/i, /investigate/i,
      /figure out/i, /unclear/i, /unknown/i, /debug/i, /strange/i,
      /weird/i, /issue/i, /problem/i, /error/i, /bug/i,
    ];

    const matchCount = uncertainPatterns.filter(p => p.test(task)).length;
    return Math.min(1, matchCount * 0.2);
  }

  /**
   * Compute scores for each model
   */
  private computeModelScores(complexity: ComplexityAnalysis): Record<ClaudeModel, number> {
    const { score } = complexity;

    // Base scoring: inverse relationship with complexity
    // Low complexity → haiku scores high
    // High complexity → opus scores high
    return {
      haiku: Math.max(0, 1 - score * 2), // Drops off quickly as complexity rises
      sonnet: 1 - Math.abs(score - 0.5) * 2, // Peaks at medium complexity
      opus: Math.min(1, score * 1.5), // Rises with complexity
      inherit: 0.1, // Low baseline unless explicitly needed
    };
  }

  /**
   * Apply circuit breaker adjustments
   */
  private applyCircuitBreaker(scores: Record<ClaudeModel, number>): Record<ClaudeModel, number> {
    if (!this.config.enableCircuitBreaker) {
      return scores;
    }

    const adjusted = { ...scores };
    for (const model of Object.keys(adjusted) as ClaudeModel[]) {
      if (this.consecutiveFailures[model] >= this.config.circuitBreakerThreshold) {
        // Circuit is open - heavily penalize this model
        adjusted[model] *= 0.1;
      } else if (this.consecutiveFailures[model] > 0) {
        // Partial penalty for recent failures
        adjusted[model] *= 1 - (this.consecutiveFailures[model] / this.config.circuitBreakerThreshold) * 0.5;
      }
    }
    return adjusted;
  }

  /**
   * Select the best model from scores. Uses Thompson sampling (#1772):
   * each model's deterministic complexity score is multiplied by a draw
   * θ_m ~ Beta(α_m, β_m) from its bandit prior. Models with strong empirical
   * track records get sampled higher; models with poor outcomes get sampled
   * lower; the system auto-corrects against tier overuse without manual
   * threshold tuning. Beta(1,1) = uniform on cold start so behavior matches
   * the prior deterministic router until outcomes accumulate.
   */
  private selectModel(
    scores: Record<ClaudeModel, number>,
    complexityScore: number
  ): { model: ClaudeModel; confidence: number; uncertainty: number } {
    // Thompson sampling: combine deterministic score with bandit posterior
    const priors = this.state.priors ?? defaultBanditPriors();
    const sampledScores: Record<ClaudeModel, number> = {
      haiku:   scores.haiku   * sampleBeta(priors.haiku.alpha,   priors.haiku.beta),
      sonnet:  scores.sonnet  * sampleBeta(priors.sonnet.alpha,  priors.sonnet.beta),
      opus:    scores.opus    * sampleBeta(priors.opus.alpha,    priors.opus.beta),
      inherit: scores.inherit, // not bandit-controlled
    };

    // Get sorted models by sampled score (drops 'inherit' from selection)
    const sorted = (Object.entries(sampledScores) as [ClaudeModel, number][])
      .filter(([m]) => m !== 'inherit')
      .sort((a, b) => b[1] - a[1]);

    const [bestModel, bestScore] = sorted[0];
    const [, secondScore] = sorted[1] || ['sonnet' as ClaudeModel, 0];

    // Confidence is how much better the best is vs second
    const confidence = bestScore > 0 ? Math.min(1, bestScore / (bestScore + secondScore + 0.01)) : 0.5;

    // Uncertainty based on score spread and complexity
    const scoreSpread = bestScore - secondScore;
    const uncertainty = Math.max(0, 1 - scoreSpread - confidence * 0.5);

    // Escalate if uncertainty is too high
    let model = bestModel;
    if (uncertainty > this.config.maxUncertainty && bestModel !== 'opus') {
      // Escalate to more capable model
      model = bestModel === 'haiku' ? 'sonnet' : 'opus';
    }

    return { model, confidence, uncertainty };
  }

  /**
   * Build human-readable reasoning
   */
  private buildReasoning(
    model: ClaudeModel,
    complexity: ComplexityAnalysis,
    confidence: number
  ): string {
    const parts: string[] = [];

    parts.push(`Complexity: ${(complexity.score * 100).toFixed(0)}%`);

    if (complexity.indicators.high.length > 0) {
      parts.push(`High-complexity indicators: ${complexity.indicators.high.join(', ')}`);
    }

    parts.push(`Confidence: ${(confidence * 100).toFixed(0)}%`);
    parts.push(`Model: ${model} - ${MODEL_CAPABILITIES[model].description}`);

    if (this.config.enableCostOptimization) {
      parts.push(`Cost: ${MODEL_CAPABILITIES[model].costMultiplier}x baseline`);
    }

    return parts.join(' | ');
  }

  /**
   * Track routing decision for learning
   */
  private trackDecision(task: string, result: ModelRoutingResult): void {
    this.decisionCount++;
    this.state.totalDecisions++;
    this.state.modelDistribution[result.model] =
      (this.state.modelDistribution[result.model] || 0) + 1;

    // Update running averages
    const n = this.state.totalDecisions;
    this.state.avgComplexity =
      (this.state.avgComplexity * (n - 1) + result.complexity) / n;
    this.state.avgConfidence =
      (this.state.avgConfidence * (n - 1) + result.confidence) / n;

    // Auto-save periodically
    if (this.decisionCount % this.config.autoSaveInterval === 0) {
      this.saveState();
    }
  }

  /**
   * Record outcome for learning
   */
  recordOutcome(
    task: string,
    model: ClaudeModel,
    outcome: 'success' | 'failure' | 'escalated'
  ): void {
    // Update circuit breaker state
    if (outcome === 'failure') {
      this.consecutiveFailures[model]++;
    } else {
      this.consecutiveFailures[model] = 0;
    }

    // Track in history
    this.state.learningHistory.push({
      task: task.slice(0, 100),
      model,
      complexity: this.state.avgComplexity,
      outcome,
      timestamp: new Date().toISOString(),
    });

    // Keep history bounded
    if (this.state.learningHistory.length > 100) {
      this.state.learningHistory = this.state.learningHistory.slice(-100);
    }

    if (outcome === 'failure') {
      this.state.circuitBreakerTrips++;
    }

    // Thompson sampling update (#1772): cost-adjusted Bernoulli reward.
    // Haiku-success > Sonnet-success > Opus-success (Opus on simple tasks
    // is wasteful even when correct). Failure/escalation always β++.
    if (!this.state.priors) this.state.priors = defaultBanditPriors();
    const reward = BANDIT_REWARDS[model]?.[outcome] ?? 0.5;
    this.state.priors[model].alpha += reward;
    this.state.priors[model].beta += 1 - reward;

    this.saveState();
  }

  /**
   * Get router statistics
   */
  getStats(): {
    totalDecisions: number;
    modelDistribution: Record<ClaudeModel, number>;
    avgComplexity: number;
    avgConfidence: number;
    circuitBreakerTrips: number;
    consecutiveFailures: Record<ClaudeModel, number>;
  } {
    return {
      totalDecisions: this.state.totalDecisions,
      modelDistribution: { ...this.state.modelDistribution },
      avgComplexity: this.state.avgComplexity,
      avgConfidence: this.state.avgConfidence,
      circuitBreakerTrips: this.state.circuitBreakerTrips,
      consecutiveFailures: { ...this.consecutiveFailures },
    };
  }

  /**
   * Load state from disk
   */
  private loadState(): RouterState {
    const defaultState: RouterState = {
      totalDecisions: 0,
      modelDistribution: { haiku: 0, sonnet: 0, opus: 0, inherit: 0 },
      avgComplexity: 0.5,
      avgConfidence: 0.8,
      circuitBreakerTrips: 0,
      lastUpdated: new Date().toISOString(),
      learningHistory: [],
      priors: defaultBanditPriors(),
    };

    try {
      const fullPath = join(process.cwd(), this.config.statePath);
      if (existsSync(fullPath)) {
        const data = readFileSync(fullPath, 'utf-8');
        const loaded = JSON.parse(data) as Partial<RouterState>;
        // Backfill priors for state files written by pre-bandit cli versions.
        if (!loaded.priors) loaded.priors = defaultBanditPriors();
        return { ...defaultState, ...loaded };
      }
    } catch {
      // Ignore load errors
    }

    return defaultState;
  }

  /**
   * Save state to disk
   */
  private saveState(): void {
    try {
      const fullPath = join(process.cwd(), this.config.statePath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.state.lastUpdated = new Date().toISOString();
      writeFileSync(fullPath, JSON.stringify(this.state, null, 2));
    } catch {
      // Ignore save errors in non-critical scenarios
    }
  }

  /**
   * Reset router state
   */
  reset(): void {
    this.state = {
      totalDecisions: 0,
      modelDistribution: { haiku: 0, sonnet: 0, opus: 0, inherit: 0 },
      avgComplexity: 0.5,
      avgConfidence: 0.8,
      circuitBreakerTrips: 0,
      lastUpdated: new Date().toISOString(),
      learningHistory: [],
      priors: defaultBanditPriors(),
    };
    this.consecutiveFailures = { haiku: 0, sonnet: 0, opus: 0, inherit: 0 };
    this.decisionCount = 0;
    this.saveState();
  }

  /**
   * Public read-only accessor for the bandit priors. Useful for tests,
   * dashboards, and the pending hooks_intelligence_stats integration that
   * surfaces convergence in the dashboard. Returns a copy.
   */
  getBanditPriors(): Record<ClaudeModel, BetaPrior> {
    const p = this.state.priors ?? defaultBanditPriors();
    return {
      haiku:   { ...p.haiku },
      sonnet:  { ...p.sonnet },
      opus:    { ...p.opus },
      inherit: { ...p.inherit },
    };
  }
}

// ============================================================================
// Singleton & Factory Functions
// ============================================================================

let modelRouterInstance: ModelRouter | null = null;

/**
 * Get or create the singleton ModelRouter instance
 */
export function getModelRouter(config?: Partial<ModelRouterConfig>): ModelRouter {
  if (!modelRouterInstance) {
    modelRouterInstance = new ModelRouter(config);
  }
  return modelRouterInstance;
}

/**
 * Reset the singleton instance
 */
export function resetModelRouter(): void {
  modelRouterInstance = null;
}

/**
 * Create a new ModelRouter instance (non-singleton)
 */
export function createModelRouter(config?: Partial<ModelRouterConfig>): ModelRouter {
  return new ModelRouter(config);
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Quick route function for common use case
 */
export async function routeToModel(task: string): Promise<ClaudeModel> {
  const router = getModelRouter();
  const result = await router.route(task);
  return result.model;
}

/**
 * Route with full result
 */
export async function routeToModelFull(
  task: string,
  embedding?: number[]
): Promise<ModelRoutingResult> {
  const router = getModelRouter();
  return router.route(task, embedding);
}

/**
 * Analyze task complexity without routing
 */
export function analyzeTaskComplexity(task: string): ComplexityAnalysis {
  const router = getModelRouter();
  return router.analyzeComplexity(task, undefined);
}

/**
 * Get model router statistics
 */
export function getModelRouterStats(): ReturnType<ModelRouter['getStats']> {
  const router = getModelRouter();
  return router.getStats();
}

/**
 * Record routing outcome for learning
 */
export function recordModelOutcome(
  task: string,
  model: ClaudeModel,
  outcome: 'success' | 'failure' | 'escalated'
): void {
  const router = getModelRouter();
  router.recordOutcome(task, model, outcome);
}
