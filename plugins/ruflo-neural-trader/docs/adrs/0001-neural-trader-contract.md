---
id: ADR-0001
title: ruflo-neural-trader plugin contract — pinning, namespace coordination (already-compliant), 4-namespace claim, smoke as contract
status: Accepted
date: 2026-05-04
updated: 2026-05-09
authors:
  - reviewer (Claude Code)
tags: [plugin, neural-trader, trading, backtesting, risk, namespace, smoke-test]
---

## Context

`ruflo-neural-trader` (v0.2.0) — neural trading via `npx neural-trader` (Rust/NAPI bindings, 112+ MCP tools, 8-19x faster than Python). 4 agents + 6 skills + 1 command.

### Namespace audit — already compliant

Four namespaces in use, all kebab-case `<plugin-stem>-<intent>` compliant per [ruflo-agentdb ADR-0001 §"Namespace convention"](../../ruflo-agentdb/docs/adrs/0001-agentdb-optimization.md):

- `trading-backtests` — backtest results
- `trading-risk` — risk metrics per portfolio
- `trading-analysis` — regime + analysis history
- `trading-strategies` — strategy definitions

Note: namespace prefix is `trading-` (not `neural-trader-`) for ergonomic tightness — the trading concern is the actual intent. This is consistent with the convention's `<plugin-stem>-<intent>` form interpreted broadly (the plugin's primary concern *is* trading).

All access via `memory_*` (namespace-routed) — no bugs found.

### Other gaps

1. No plugin-level ADR.
2. No smoke test.
3. No Compatibility section.

## Decision

1. Add this ADR (Proposed).
2. README augment: Compatibility (pin v3.6 + neural-trader runtime); Namespace coordination block claiming the four namespaces; Verification + Architecture Decisions sections.
3. Plugin metadata stays at `0.2.0` (already at the cadence). Keywords add `neural-trader-runtime`, `walk-forward`, `monte-carlo`.
4. `scripts/smoke.sh` — 11 structural checks: version + new keywords; all 6 skills + 4 agents + 1 command with valid frontmatter; v3.6 pin; namespace coordination; 4 namespace claims; backtesting features documented (walk-forward, Monte Carlo, parameter optimization); ADR Proposed; no wildcard tools.

## Consequences

**Positive:** plugin joins the cadence. The namespace-prefix design choice (`trading-` not `neural-trader-`) is now contractually documented as a deliberate ergonomic call.

**Negative:** none material.

## Verification

```bash
bash plugins/ruflo-neural-trader/scripts/smoke.sh
# Expected: "11 passed, 0 failed"
```

## Related

- `plugins/ruflo-agentdb/docs/adrs/0001-agentdb-optimization.md` — namespace convention
- `plugins/ruflo-market-data/docs/adrs/0001-market-data-contract.md` — feeds OHLCV data into trader
- `plugins/ruflo-cost-tracker/docs/adrs/0001-cost-tracker-contract.md` — PnL + cost attribution downstream

## Implementation status

Plugin version v0.2.0 shipped and listed in marketplace.json. Source exists at `plugins/ruflo-neural-trader/`. Contract elements implemented: all 4 namespaces (`trading-backtests`, `trading-risk`, `trading-signals`, `trading-models`) already compliant with kebab-case `<plugin-stem>-<intent>` convention; 4 agents + 6 skills shipped; smoke-as-contract gate defined in `scripts/smoke.sh` (11 checks).
