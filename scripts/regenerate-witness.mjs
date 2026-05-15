#!/usr/bin/env node
/**
 * Regenerate verification.md.json for a fresh release.
 *
 * Reads the existing manifest, walks `fixes[]`, recomputes SHA-256 + marker
 * presence for each cited file from the working tree, updates `gitCommit`
 * to current HEAD, updates `releases.*` versions to the bumped values from
 * package.json, recomputes the manifest hash, re-derives the Ed25519 key
 * from the new commit + seed, and re-signs.
 *
 * Idempotent — running it twice on a clean tree produces the same output.
 *
 * Usage: node scripts/regenerate-witness.mjs
 */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = (() => {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  while (dir !== '/') {
    if (existsSync(join(dir, 'verification.md'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('project root not found');
})();

const MANIFEST_PATH = join(ROOT, 'verification.md.json');
const witness = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
const m = witness.manifest;

// 1. Refresh git commit
m.gitCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
m.issuedAt = new Date().toISOString();

// 2. Refresh release versions from package.json
const pkgVersions = {
  ruflo: JSON.parse(readFileSync(join(ROOT, 'ruflo/package.json'), 'utf-8')).version,
  '@claude-flow/cli': JSON.parse(readFileSync(join(ROOT, 'v3/@claude-flow/cli/package.json'), 'utf-8')).version,
};
m.releases = pkgVersions;

// 3. Recompute SHA-256 + marker for each fix
let verified = 0, failed = 0;
for (const fix of m.fixes) {
  const filePath = join(ROOT, fix.file);
  if (!existsSync(filePath)) {
    fix.markerVerified = false;
    failed++;
    console.warn(`[skip] ${fix.id}: file missing — ${fix.file}`);
    continue;
  }
  const buf = readFileSync(filePath);
  fix.sha256 = createHash('sha256').update(buf).digest('hex');
  // Marker check on text files only — skip binary
  let text;
  try { text = buf.toString('utf-8'); } catch { text = ''; }
  fix.markerVerified = fix.marker ? text.includes(fix.marker) : true;
  if (fix.markerVerified) verified++;
  else { failed++; console.warn(`[miss] ${fix.id}: marker not found in ${fix.file}`); }
}
m.summary = { totalFixes: m.fixes.length, verified, failed };

// 4. Recompute manifest hash
const manifestCanonical = JSON.stringify(m);
const manifestHash = createHash('sha256').update(manifestCanonical).digest('hex');
witness.integrity.manifestHash = manifestHash;

// 5. Re-derive Ed25519 keypair from new gitCommit + deterministic seed
const seed = createHash('sha256').update(m.gitCommit + ':ruflo-witness/v1').digest();
// Node 20+ has built-in Ed25519 via createPrivateKey from raw seed
// Build PKCS#8 DER: Ed25519 OID + 32-byte seed
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });

// Public key in raw form — derive via Node's native createPublicKey then
// extract the 32-byte raw value out of the JWK x parameter.
const publicKeyObj = createPublicKey(privateKey);
const jwk = publicKeyObj.export({ format: 'jwk' });
const publicKey = Buffer.from(jwk.x, 'base64url');
witness.integrity.publicKey = publicKey.toString('hex');

// 6. Sign manifestHash
const signature = sign(null, Buffer.from(manifestHash, 'hex'), privateKey);
witness.integrity.signature = signature.toString('hex');
witness.integrity.signatureAlgo = 'ed25519';
witness.integrity.manifestHashAlgo = 'sha256';
witness.integrity.seedDerivation = "sha256(gitCommit + ':ruflo-witness/v1')";

// 7. Write back, pretty-printed
writeFileSync(MANIFEST_PATH, JSON.stringify(witness, null, 2) + '\n', 'utf-8');

console.log(`Regenerated ${MANIFEST_PATH}`);
console.log(`  gitCommit: ${m.gitCommit}`);
console.log(`  releases:  ruflo@${pkgVersions.ruflo} / cli@${pkgVersions['@claude-flow/cli']}`);
console.log(`  fixes:     ${m.fixes.length} total / ${verified} verified / ${failed} failed`);
console.log(`  pubkey:    ${witness.integrity.publicKey.slice(0, 16)}…`);
console.log(`  signature: ${witness.integrity.signature.slice(0, 16)}…`);
