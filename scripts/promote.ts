#!/usr/bin/env tsx
/**
 * DRAFT -> VERIFIED. Deliberately a separate, manual step from
 * compilation -- verification means "this replayed green on inputs
 * discovery never used" (see the Slice 7 gate in docs/slices.md), which
 * this script does NOT itself run; it only flips status after you've
 * confirmed that yourself, e.g.:
 *
 *   npm run replay -- --capability member.read-savings-balance --version 2 \
 *     --input memberId=67890 --evidence-dir evidence/verify-compiled
 *   npm run promote -- --path capabilities/member.read-savings-balance.v2.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CapabilityDefinitionSchema } from '../src/contracts/index.js';

function parseArgs(argv: string[]) {
  const args: { path?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path') args.path = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.path) {
  console.error('Usage: promote --path <capability-json-path>');
  process.exit(1);
}

const artifact = CapabilityDefinitionSchema.parse(JSON.parse(readFileSync(args.path, 'utf-8')));
if (artifact.status !== 'draft') {
  console.error(`Artifact status is "${artifact.status}", not "draft" -- refusing to promote.`);
  process.exit(1);
}

artifact.status = 'verified';
writeFileSync(args.path, JSON.stringify(artifact, null, 2) + '\n', 'utf-8');
console.log(`${artifact.capabilityId}@${artifact.version} -> VERIFIED`);
