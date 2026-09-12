#!/usr/bin/env tsx
/**
 * Emits JSON Schema for CapabilityDefinition from the single Zod source of
 * truth. This is the same object that later feeds an agent-facing tool
 * definition (Slice 9's capability catalog) — one schema, three consumers
 * (TS types, runtime validation, JSON Schema), no drift between them.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CapabilityDefinitionSchema } from '../src/contracts/index.js';

const outPath = fileURLToPath(new URL('../docs/capability.schema.json', import.meta.url));

const schema = zodToJsonSchema(CapabilityDefinitionSchema, 'CapabilityDefinition');

writeFileSync(outPath, JSON.stringify(schema, null, 2) + '\n', 'utf-8');
console.log(`Wrote JSON Schema to ${outPath}`);
