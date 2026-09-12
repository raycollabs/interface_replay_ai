#!/usr/bin/env tsx
/**
 * Validates every *.json file in /capabilities against CapabilityDefinitionSchema.
 * This is the gate: a malformed artifact must never be loadable by the
 * replay engine, and this script is the cheapest place to catch that —
 * before it ever reaches a browser.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapabilityDefinitionSchema } from '../src/contracts/index.js';

const capabilitiesDir = fileURLToPath(new URL('../capabilities', import.meta.url));

const files = readdirSync(capabilitiesDir).filter((f) => f.endsWith('.json'));

if (files.length === 0) {
  console.error(`No capability artifacts found in ${capabilitiesDir}`);
  process.exit(1);
}

let failed = 0;

for (const file of files) {
  const path = join(capabilitiesDir, file);
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`✗ ${file} — invalid JSON: ${(err as Error).message}`);
    failed++;
    continue;
  }

  const result = CapabilityDefinitionSchema.safeParse(parsed);
  if (result.success) {
    const cap = result.data;
    console.log(
      `✓ ${file} — ${cap.capabilityId}@${cap.version} (${cap.status}) — ` +
        `${cap.steps.length} steps, ${Object.keys(cap.inputs).length} inputs, ` +
        `${Object.keys(cap.outputs).length} outputs, ${cap.knownOutcomes.length} known outcomes`,
    );
  } else {
    console.error(`✗ ${file} — schema validation failed:`);
    for (const issue of result.error.issues) {
      console.error(`    ${issue.path.join('.')}: ${issue.message}`);
    }
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${files.length} artifact(s) failed validation.`);
  process.exit(1);
}

console.log(`\nAll ${files.length} artifact(s) valid.`);
