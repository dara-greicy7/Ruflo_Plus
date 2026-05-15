#!/usr/bin/env node
/**
 * Verify a signed witness manifest against the live tree (ADR-103).
 *
 * Project-agnostic — works without ruflo CLI being installed.
 *
 * Usage:
 *   node verify.mjs --manifest <path> [--root <path>] [--json]
 *
 * Exit codes:
 *   0  — signature valid + all fixes pass or drift (marker present)
 *   1  — signature invalid OR any fix regressed/missing
 *   2  — bad arguments / file not found
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileSha256, fileContains } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.manifest) { console.error('--manifest <path> required'); process.exit(2); }

const manifestPath = resolve(args.manifest);
if (!existsSync(manifestPath)) { console.error(`not found: ${manifestPath}`); process.exit(2); }

const repoRoot = resolve(args.root ?? process.cwd());
const asJson = !!args.json;

const witness = JSON.parse(readFileSync(manifestPath, 'utf8'));

// ─── signature ────────────────────────────────────────────────────
const sig = await verifySignature(witness, repoRoot);

// ─── per-fix marker check ─────────────────────────────────────────
const fileResults = witness.manifest.fixes.map((fix) => {
  const installed = join(repoRoot, fix.file);
  if (!existsSync(installed)) {
    return { ...fix, status: 'missing', sha256Match: false, markerPresent: false };
  }
  const localSha256 = fileSha256(installed);
  const markerPresent = fileContains(installed, fix.marker);
  const sha256Match = localSha256 === fix.sha256;
  const status = sha256Match && markerPresent ? 'pass'
              : (markerPresent ? 'drift' : 'regressed');
  return { ...fix, status, sha256Match, markerPresent, localSha256 };
});

const summary = {
  pass: fileResults.filter(r => r.status === 'pass').length,
  drift: fileResults.filter(r => r.status === 'drift').length,
  regressed: fileResults.filter(r => r.status === 'regressed').length,
  missing: fileResults.filter(r => r.status === 'missing').length,
};
const ok = sig.signatureValid && sig.manifestHashOk && sig.publicKeyReproducible
        && summary.regressed === 0 && summary.missing === 0;

if (asJson) {
  console.log(JSON.stringify({ ok, signature: sig, summary, results: fileResults }, null, 2));
} else {
  console.log('Manifest signature:');
  console.log(`  hash matches:                    ${sig.manifestHashOk ? 'yes' : 'NO'}`);
  console.log(`  public key reproducible:         ${sig.publicKeyReproducible ? 'yes' : 'NO'}`);
  console.log(`  Ed25519 signature valid:         ${sig.signatureValid ? 'yes' : 'NO'}`);
  console.log('');
  console.log(`Summary: pass=${summary.pass} drift=${summary.drift} regressed=${summary.regressed} missing=${summary.missing}`);
  if (summary.regressed > 0) {
    console.log('\nRegressed:');
    for (const r of fileResults.filter(r => r.status === 'regressed')) {
      console.log(`  ${r.id}  marker missing in ${r.file}`);
    }
  }
  if (summary.missing > 0) {
    console.log('\nMissing files:');
    for (const r of fileResults.filter(r => r.status === 'missing')) {
      console.log(`  ${r.id}  ${r.file}`);
    }
  }
}

process.exit(ok ? 0 : 1);

// ─── ed25519 helpers ─────────────────────────────────────────────
async function verifySignature(witness, repoRoot) {
  // Probe multiple plausible install roots — pnpm's isolated linker
  // doesn't hoist transitive deps to v3/node_modules, so we also check
  // workspace packages that declare @noble/ed25519 directly. A user's
  // flat npm install satisfies the first probe; pnpm satisfies the latter.
  let ed;
  let probeErr;
  const probes = [
    repoRoot,
    join(repoRoot, 'v3'),
    join(repoRoot, 'v3/@claude-flow/cli'),
    join(repoRoot, 'v3/@claude-flow/plugin-agent-federation'),
  ];
  for (const root of probes) {
    try { ed = createRequire(join(root, 'noop.js'))('@noble/ed25519'); break; }
    catch (e) { probeErr = e; }
  }
  if (!ed) {
    console.error(`verify.mjs: could not load @noble/ed25519 from any of:\n  ${probes.join('\n  ')}\n  last error: ${probeErr?.message ?? '?'}`);
    return { manifestHashOk: false, publicKeyReproducible: false, signatureValid: false };
  }

  ed.etc.sha512Sync = (...m) => { const h = createHash('sha512'); for (const x of m) h.update(x); return h.digest(); };

  const recomputed = createHash('sha256').update(JSON.stringify(witness.manifest)).digest('hex');
  const manifestHashOk = recomputed === witness.integrity.manifestHash;
  const seed = createHash('sha256').update(witness.manifest.gitCommit + ':ruflo-witness/v1').digest();
  const reKey = ed.getPublicKey(seed);
  const publicKeyReproducible = Buffer.from(reKey).toString('hex') === witness.integrity.publicKey;
  const signatureValid = ed.verify(
    Buffer.from(witness.integrity.signature, 'hex'),
    Buffer.from(witness.integrity.manifestHash, 'hex'),
    Buffer.from(witness.integrity.publicKey, 'hex'),
  );
  return { manifestHashOk, publicKeyReproducible, signatureValid };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--help') { out[a.slice(2)] = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else { out[key] = true; }
    }
  }
  return out;
}
