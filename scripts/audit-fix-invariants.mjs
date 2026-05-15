#!/usr/bin/env node
/**
 * Fix-invariants audit — guards against silent regression of the recent
 * critical fixes that don't have a dedicated audit script.
 *
 * Each entry pins one or more substrings/regexes that MUST exist in a
 * specific source file. The substring is the load-bearing line from the
 * fix — if a refactor accidentally removes it, the bug returns silently
 * (no test failure, just wrong runtime behavior).
 *
 * This is intentionally a presence-check (not a behavior test). Behavior
 * is covered by the dedicated audits (audit-vector-dim, audit-hook-
 * handler-prompt) and unit tests; this script is the cheap last-mile
 * guard for fixes whose dedicated test wasn't worth writing alone.
 *
 * Usage:
 *   node scripts/audit-fix-invariants.mjs           # exit 1 on any miss
 *   node scripts/audit-fix-invariants.mjs --json    # machine-readable report
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const JSON_OUT = process.argv.includes('--json');

/**
 * Each entry: a fix-issue, the file the invariant lives in, and either a
 * `substring` (must appear verbatim) or a `regex` (must match). Add a
 * short `why` so the failure message tells the next developer what
 * runtime behavior breaks if they remove the line.
 *
 * @typedef {Object} Invariant
 * @property {string} issue        — e.g. '#1945' (for failure messages)
 * @property {string} file         — repo-relative path
 * @property {string} [substring]  — must appear verbatim
 * @property {RegExp} [regex]      — must match somewhere in the file
 * @property {string} why          — what breaks if this line is removed
 */
/** @type {Invariant[]} */
const INVARIANTS = [
  // #1939 — Win32 cwd → Claude Code slug
  {
    issue: '#1939',
    file: 'v3/@claude-flow/cli/src/mcp-tools/memory-tools.ts',
    regex: /\/\^\[A-Za-z\]:\[\\\\\/\]\//,
    why: 'Win32 slug candidate regex (`^[A-Za-z]:[\\/]`) — without it, memory_import_claude({allProjects:false}) returns 0 on Win32 paths like `C:\\Users\\…\\Claude Stuff`.',
  },
  {
    issue: '#1939',
    file: 'v3/@claude-flow/cli/src/mcp-tools/memory-tools.ts',
    substring: "replace(/[:\\\\/]/g, '-')",
    why: 'Win32 slug normalization — drops `:` / `\\` / `/` so `C:\\Users\\…\\Claude Stuff` → `C--Users-…-Claude-Stuff`.',
  },

  // #1941 — provision per-namespace vector_indexes row before entry insert
  {
    issue: '#1941',
    file: 'v3/@claude-flow/cli/src/memory/memory-bridge.ts',
    substring: 'INSERT OR IGNORE INTO vector_indexes (id, name, dimensions)',
    why: 'Per-namespace vector_indexes provisioning in bridgeStoreEntry — without it, memory_search({namespace:"X"}) returns 0 for any non-default namespace.',
  },
  {
    issue: '#1941',
    file: 'v3/@claude-flow/cli/src/memory/memory-initializer.ts',
    substring: 'INSERT OR IGNORE INTO vector_indexes (id, name, dimensions)',
    why: 'Per-namespace vector_indexes provisioning in storeEntry (sql.js fallback) — same root cause as the bridge path; one needs both branches.',
  },

  // #1943 — settings-generator project-local OR $HOME probe
  {
    issue: '#1943',
    file: 'v3/@claude-flow/cli/src/init/settings-generator.ts',
    substring: '[ -f "$D/',
    why: 'POSIX sh probe in hookCmd() — without it, global-install hook paths anchor at `${CLAUDE_PROJECT_DIR}` only and every Bash/Edit/Session hook fires MODULE_NOT_FOUND.',
  },
  {
    issue: '#1943',
    file: 'v3/@claude-flow/cli/src/init/settings-generator.ts',
    substring: 'IF EXIST',
    why: 'Windows `cmd /c IF EXIST … ELSE …` fallback — Win32 equivalent of the sh probe.',
  },

  // #1945 / #1946 — memory bridge + doctor honor CLAUDE_FLOW_MEMORY_PATH
  {
    issue: '#1945',
    file: 'v3/@claude-flow/cli/src/memory/memory-bridge.ts',
    substring: 'getMemoryRoot',
    why: 'getDbPath() routes through getMemoryRoot() — without it, the bridge hard-codes `<cwd>/.swarm/memory.db` and CLI store writes to a different file than memory init created.',
  },
  {
    issue: '#1946',
    file: 'v3/@claude-flow/cli/src/commands/doctor.ts',
    substring: 'getMemoryRoot',
    why: 'doctor.checkMemoryDatabase() routes through getMemoryRoot() — without it, doctor reports "Not initialized" on any DB at a non-default path.',
  },

  // #1951 — statusline reads installed version from plugin package.json
  {
    issue: '#1951',
    file: 'v3/@claude-flow/cli/.claude/helpers/statusline.cjs',
    substring: 'RUFLO_VERSION',
    why: 'Startup version-probe variable in the deployed statusline — without it the header reverts to a hard-coded `RuFlo V3.5`.',
  },
  {
    issue: '#1951',
    file: 'v3/@claude-flow/cli/.claude/helpers/statusline.cjs',
    substring: '.claude/plugins/marketplaces/ruflo',
    why: 'Plugin-install candidate path probed first — without it, plugin users always fall through to the hardcoded default.',
  },
  {
    issue: '#1951',
    file: '.claude/helpers/statusline.cjs',
    substring: '.claude/plugins/marketplaces/ruflo',
    why: 'Same plugin-install candidate in the root statusline copy.',
  },
  {
    issue: '#1951',
    file: 'v3/@claude-flow/cli/src/init/statusline-generator.ts',
    substring: '.claude/plugins/marketplaces/ruflo',
    why: 'Same plugin-install candidate in the init template that generates project-local statuslines.',
  },

  // #1953 — hooks_pretrain code-file budget + code-dir-first traversal
  {
    issue: '#1953',
    file: 'v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts',
    substring: 'codeFilesScanned',
    why: 'Separate code-file budget counter — without it, the 50-file budget is burned by .md/.yaml/.db files and patternsExtracted: 0 on docs-heavy repos.',
  },

  // #1968 — daemon launcher forwards --workers / --headless / --sandbox
  {
    issue: '#1968',
    file: 'v3/@claude-flow/cli/src/commands/daemon.ts',
    regex: /forkArgs\.push\(['"]--workers['"]/,
    why: 'Daemon launcher forwards --workers to the forked child — without it, `daemon start --workers map` silently uses the default worker set.',
  },
  {
    issue: '#1968',
    file: 'v3/@claude-flow/cli/src/commands/daemon.ts',
    regex: /forkArgs\.push\(['"]--headless['"]\)/,
    why: 'Daemon launcher forwards --headless — same family as the --workers gap.',
  },
];

const offenders = [];
for (const inv of INVARIANTS) {
  const p = join(REPO_ROOT, inv.file);
  if (!existsSync(p)) {
    offenders.push({ ...inv, error: 'file missing' });
    continue;
  }
  const src = readFileSync(p, 'utf8');
  const found = inv.substring
    ? src.includes(inv.substring)
    : inv.regex
    ? inv.regex.test(src)
    : false;
  if (!found) {
    offenders.push({ ...inv, error: 'invariant missing' });
  }
}

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ checked: INVARIANTS.length, offenders }, null, 2) + '\n');
  process.exit(offenders.length === 0 ? 0 : 1);
}

console.log(`fix-invariants audit — ${INVARIANTS.length} invariants across ${new Set(INVARIANTS.map(i => i.file)).size} file(s)`);
if (offenders.length === 0) {
  console.log(`  ✓ all invariants present`);
  process.exit(0);
}

console.error(`\n  ✗ ${offenders.length} missing invariant(s):`);
for (const o of offenders) {
  console.error(`\n    [${o.issue}] ${o.file}`);
  console.error(`      ${o.error}: ${o.substring ?? o.regex}`);
  console.error(`      why this matters: ${o.why}`);
}
console.error('\n  If the fix moved to a different file or got refactored, update the invariant in scripts/audit-fix-invariants.mjs to point at the new location — do NOT delete it without confirming the regression is impossible by another mechanism.');
process.exit(1);
