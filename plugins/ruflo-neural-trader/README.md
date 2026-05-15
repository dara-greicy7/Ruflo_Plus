# ruflo-neural-trader

Neural trading strategies powered by [`neural-trader`](https://www.npmjs.com/package/neural-trader) (v2.7+) — self-learning LSTM/Transformer/N-BEATS models, Rust/NAPI backtesting (8-19x faster), 112+ MCP tools, swarm coordination, and portfolio optimization.

## Overview

Wraps the `neural-trader` npm package as a Ruflo plugin with 4 specialized agents, 7 skills, and comprehensive CLI commands. Adds AgentDB memory persistence, SONA trajectory learning, and swarm-coordinated execution on top of neural-trader's Rust/NAPI engine.

Heavy jobs — multi-year walk-forward backtests, large Monte-Carlo runs, parameter sweeps, LSTM/Transformer/N-BEATS training — can be dispatched to an Anthropic Managed Agent **cloud container** instead of running locally: see the `trader-cloud-backtest` skill, the `/trader cloud <backtest|train|sweep>` command, and [ADR-117](../../v3/docs/adr/ADR-117-neural-trader-managed-agent-backtests.md) (built on the `managed_agent_*` runtime from the `ruflo-agent` plugin / [ADR-115](../../v3/docs/adr/ADR-115-managed-agents-rvagent-backend.md); needs `ANTHROPIC_API_KEY` + Managed Agents beta — degrades to the local `trader-backtest` skill without it).

## Prerequisites

> ✅ **`neural-trader@^2.8.11`** (shipped 2026-05-14; see [post-mortem gist](https://gist.github.com/ruvnet/a1aca90a5c299d89fa92e905dab11041) and [announcement #1981](https://github.com/ruvnet/ruflo/issues/1981)).
> Resolves four compounding bugs that made the package unusable since v2.5.0:
> 1. Install-hook fork-bomb (#1974 — 120 GB RAM on Apple Silicon) — fixed in 2.7.2 ([neural-trader#109](https://github.com/ruvnet/neural-trader/pull/109)).
> 2. `require('neural-trader')` always threw `Cannot find module './src/cli/lib/napi-loader-shared'` — missing files restored in 2.7.5 ([neural-trader#111](https://github.com/ruvnet/neural-trader/pull/111)).
> 3. `cargo build` aborted on `aarch64-apple-darwin` (`fasthash-sys` x86-only SIMD) — placeholder hash replaced with stdlib `DefaultHasher` in 2.7.5.
> 4. npm tarball claimed 5 platform binaries, shipped 1 — `darwin-arm64` + `darwin-x64` added in 2.7.6.
>
> The 2.8.x line additionally adds a flag-style CLI dispatcher (`--backtest`, `--signal scan`, `--risk assess`, `--portfolio optimize`, `--regime`, `--train`, `--predict`, `--strategy-create`) running real math (SMA crossover / RSI mean-reversion / pairs z-score / adaptive regime-switching / multi-indicator RSI+MACD+Bollinger) against real Yahoo Finance data via `--live`. Supports `--walk-forward`, `--monte-carlo`, `--symbols A,B,C`, `--benchmark SPY`, `--optimize --param "name:min:max:step"`. The runtime smoke ([scripts/runtime-smoke.sh](scripts/runtime-smoke.sh)) covers 20 documented entry points end-to-end (basic commands + Kelly + walk-forward + Monte Carlo + optimize + multi-symbol + pairs + adaptive + multi-indicator).

```bash
# Recommended — keeps --ignore-scripts as defense in depth. The install
# hook is safe in 2.7.2+, but --ignore-scripts protects against any
# future install-script regression on this or transitive packages.
npm install --ignore-scripts neural-trader@^2.8.11
```

| Platform | Native binding in 2.8.11 |
|----------|--------------------------|
| `linux-x64-gnu` | ✅ |
| `darwin-arm64` (Apple Silicon) | ✅ first shipped in 2.7.5 |
| `darwin-x64` (Intel Macs) | ✅ first shipped in 2.7.6 |
| `linux-arm64-gnu` | ⏳ JS surface works, native calls throw at runtime |
| `win32-x64-msvc` | ⏳ JS surface works, native calls throw at runtime |

> 🚨 **If you must use an older version** (`neural-trader@2.7.1` or below — same fork-bomb risk on every non-linux-x64 host) always pass `--ignore-scripts` to skip the malicious install hook. The `linux-x64` binary is hardcoded inline in the tarball, so on `linux-x64` the package still works after `--ignore-scripts`. On other platforms `--ignore-scripts` at least won't fork-bomb your machine.
>
> ```bash
> # Only needed for neural-trader <= 2.7.1 — DO NOT run plain `npm install
> # neural-trader@<=2.7.1` on macOS / Windows / linux-arm64.
> npm install --ignore-scripts neural-trader@<=2.7.1
> ```

The `audit-neural-trader-safety.mjs` CI guard in this repo still enforces `--ignore-scripts` on every documented invocation — defense in depth in case anyone pins to an older version in a lockfile.

## Installation

```bash
claude --plugin-dir plugins/ruflo-neural-trader
```

## MCP Integration (112+ Tools)

neural-trader exposes 112+ MCP tools for direct Claude Desktop access:

```bash
claude mcp add neural-trader -- npx neural-trader mcp start
```

## Agents

| Agent | Model | Role |
|-------|-------|------|
| `trading-strategist` | opus | Strategy design, LSTM/Transformer training, Z-score anomaly detection, backtest orchestration |
| `risk-analyst` | sonnet | VaR/CVaR assessment, Kelly criterion sizing, circuit breakers, correlation monitoring |
| `market-analyst` | sonnet | Regime detection, technical indicators (RSI/MACD/Bollinger), sector analysis, correlation |
| `backtest-engineer` | sonnet | Walk-forward validation, Monte Carlo simulation, parameter optimization, benchmark comparison |

## Skills

| Skill | Usage | Description |
|-------|-------|-------------|
| `trader-backtest` | `/trader-backtest <strategy> --symbol SPY` | Rust/NAPI backtest with walk-forward validation |
| `trader-signal` | `/trader-signal [--strategy NAME]` | Z-score anomaly detection signal generation |
| `trader-portfolio` | `/trader-portfolio [--risk-target 0.15]` | Mean-variance portfolio optimization |
| `trader-regime` | `/trader-regime [--symbol SPY]` | Market regime detection and classification |
| `trader-train` | `/trader-train lstm --symbol TSLA` | Train neural prediction models |
| `trader-risk` | `/trader-risk [--symbol AAPL]` | VaR, position sizing, circuit breaker status |
| `trader-cloud-backtest` | `/trader cloud backtest <strategy> --symbol SPY` | Dispatch a heavy backtest / training / sweep to an Anthropic Managed Agent cloud container ([ADR-117](../../v3/docs/adr/ADR-117-neural-trader-managed-agent-backtests.md)) |

## Commands

```bash
# Strategy management
trader strategy create <name> --type <momentum|mean-reversion|pairs|adaptive>
trader backtest <strategy> --symbol <TICKER> --period <range>

# Neural model training
trader train <lstm|transformer|nbeats> --symbol <TICKER>

# Signal generation
trader signal scan [--strategy <name>] [--symbols <TICKERS>]

# Market analysis
trader regime --symbol <TICKER>
trader indicators --symbol <TICKER> --indicators rsi,macd,bollinger
trader correlation --symbols <TICKERS> --window 30d

# Risk & portfolio
trader risk assess [--symbol <TICKER>]
trader portfolio optimize [--risk-target <number>]

# Live trading
trader live --broker <name> [--swarm enabled]

# History
trader history
```

## Neural Models (via neural-trader)

| Model | Type | Use Case |
|-------|------|----------|
| LSTM | Recurrent | Sequence prediction, price forecasting |
| Transformer | Attention | Multi-variate pattern recognition |
| N-BEATS | Decomposition | Trend/seasonality decomposition |

```bash
npx neural-trader --model lstm --symbol TSLA --confidence 0.95
npx neural-trader --model transformer --symbol BTC-USD --predict
npx neural-trader --model nbeats --symbol SPY --decompose
```

## Strategy Types

| Strategy | CLI Flag | Entry Logic |
|----------|----------|-------------|
| Momentum | `--strategy momentum` | RSI + MACD confirmation |
| Mean-reversion | `--strategy mean-reversion` | Z-score > 2.0, Bollinger extremes |
| Pairs trading | `--strategy pairs` | Cointegration spread divergence |
| Multi-indicator | `--strategy multi-indicator` | RSI + MACD + Bollinger combined |
| Adaptive | `--strategy adaptive` | Auto-switches by regime |

## Market Regime Detection

| Regime | Indicators | Recommended Strategy |
|--------|-----------|---------------------|
| Bull trending | ADX > 25, price > 200 SMA | Momentum, trend-following |
| Bear trending | ADX > 25, price < 200 SMA | Short momentum, hedging |
| Ranging | ADX < 20, Bollinger squeeze | Mean-reversion |
| High volatility | VIX > 25, ATR expanding | Reduce size, widen stops |
| Transitioning | Divergences forming | Wait for confirmation |

## Anomaly Detection

neural-trader Z-score composite scoring on OHLCV: `anomalyScore = min(1, meanZ / 3)`

| Type | Detection | Market Interpretation |
|------|-----------|----------------------|
| spike | maxZ > 5 | Breakout / gap |
| drift | 1-2 dims sustained | Sustained trend |
| flatline | all near zero | Consolidation |
| oscillation | alternating | Range-bound |
| pattern-break | moderate Z, multi-dim | Regime change |
| cluster-outlier | >50% dims high | Multi-factor dislocation |

## Circuit Breakers

| Breaker | Trigger | Action |
|---------|---------|--------|
| Daily loss | Drawdown > 3%/day | Halt new entries |
| Weekly loss | Drawdown > 5%/week | Reduce sizes 50% |
| Correlation spike | Portfolio corr > 0.85 | Reduce correlated positions |
| Volatility regime | VIX > 2x historical | Minimum position sizes |
| Max positions | Open > limit | Block new entries |
| Concentration | Any position > 10% | Force trim |

## Backtesting Features

| Feature | Command |
|---------|---------|
| Walk-forward | `--walk-forward --train-window 6M --test-window 1M` |
| Monte Carlo | `--monte-carlo --simulations 1000` |
| Parameter optimization | `--optimize --param "entry_z:1.5:3.0:0.25"` |
| Multi-symbol | `--symbols "AAPL,MSFT,GOOGL"` |
| Benchmark comparison | `--benchmark SPY` |

## Performance

neural-trader uses Rust/NAPI bindings for zero-overhead performance:
- **8-19x faster** than Python equivalents
- **Sub-200ms** order execution and risk checks
- **WASM/SIMD** acceleration available
- **52,000+ inserts/sec** for market data

## Compatibility

- **CLI:** pinned to `@claude-flow/cli` v3.6 major+minor.
- **Runtime:** `npx neural-trader` (Rust/NAPI bindings — 112+ MCP tools).
- **Verification:** `bash plugins/ruflo-neural-trader/scripts/smoke.sh` is the contract.

## Namespace coordination

This plugin owns four AgentDB namespaces (kebab-case, follows the convention from [ruflo-agentdb ADR-0001 §"Namespace convention"](../ruflo-agentdb/docs/adrs/0001-agentdb-optimization.md)):

| Namespace | Purpose |
|-----------|---------|
| `trading-strategies` | Strategy definitions (loaded by `trader-backtest`, `trader-signal`) |
| `trading-backtests` | Backtest results indexed by strategy + timestamp |
| `trading-risk` | Risk metrics per portfolio |
| `trading-analysis` | Regime detection + market analysis history |

Note: the namespace prefix is `trading-` (the actual intent) rather than `neural-trader-` (the plugin stem). This is a deliberate ergonomic choice — `trading` is the load-bearing concern downstream consumers reason about. Reserved namespaces (`pattern`, `claude-memories`, `default`) MUST NOT be shadowed.

All access via `memory_*` (namespace-routed). No `agentdb_hierarchical-*` or `agentdb_pattern-store` with namespace arguments — the plugin uses the correct routing throughout.

## Verification

```bash
bash plugins/ruflo-neural-trader/scripts/smoke.sh
# Expected: "11 passed, 0 failed"
```

## Architecture Decisions

- [`ADR-0001` — ruflo-neural-trader plugin contract (already-compliant namespaces, 4-namespace claim, smoke as contract)](./docs/adrs/0001-neural-trader-contract.md)
- [`ADR-117`](../../v3/docs/adr/ADR-117-neural-trader-managed-agent-backtests.md) — run heavy jobs (walk-forward / Monte-Carlo / sweep / training) on the Managed Agent cloud runtime (the `trader-cloud-backtest` skill + `/trader cloud` command), with cost-optimization rules
- [`ADR-115`](../../v3/docs/adr/ADR-115-managed-agents-rvagent-backend.md) — the `managed_agent_*` cloud runtime that ADR-117 builds on (lives in the `ruflo-agent` plugin)

## Related Plugins

- `ruflo-agent` — the `managed_agent_*` cloud agent runtime used by the `trader-cloud-backtest` skill (ADR-115 / ADR-117)
- `ruflo-agentdb` — namespace convention owner; backing store
- `ruflo-market-data` — OHLCV data ingestion and candlestick pattern detection (feeds `trading-strategies`)
- `ruflo-ruvector` — HNSW indexing for strategy pattern similarity search
- `ruflo-cost-tracker` — PnL tracking and cost attribution
- `ruflo-observability` — Strategy performance dashboards

## License

MIT
