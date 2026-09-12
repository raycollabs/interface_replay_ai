import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { CapabilityDefinitionSchema, type CapabilityDefinition } from '../contracts/index.js';

/**
 * "Think of it as a capability an AI agent can call" -- the brief's own
 * framing for the artifact (3.2), made literal. Every saved artifact IS
 * already a typed contract (inputs, outputs, description); this module
 * is the thin layer that turns that contract into an Anthropic tool
 * definition, using the SAME Zod schema that validates the artifact on
 * disk -- one source of truth for the shape, not a second one
 * hand-maintained alongside it.
 */

export interface CatalogEntry {
  capability: CapabilityDefinition;
  toolName: string;
  toolDefinition: Anthropic.Tool;
}

/** Anthropic tool names must match ^[a-zA-Z0-9_-]{1,128}$ -- capability
 *  IDs use dots (member.read-savings-balance), so this is a lossy but
 *  reversible-in-practice sanitization for the catalog's lifetime. */
function toToolName(capabilityId: string, version: number): string {
  return `${capabilityId.replace(/[^a-zA-Z0-9_-]/g, '_')}_v${version}`;
}

function jsonTypeFor(inputType: 'string' | 'number' | 'boolean'): string {
  return inputType;
}

function toToolDefinition(capability: CapabilityDefinition): Anthropic.Tool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, def] of Object.entries(capability.inputs)) {
    properties[name] = {
      type: jsonTypeFor(def.type),
      description: def.example ? `${def.pattern ? `Pattern: ${def.pattern}. ` : ''}Example: ${def.example}` : def.pattern,
    };
    if (def.required) required.push(name);
  }

  const outputsSummary = Object.entries(capability.outputs)
    .map(([name, def]) => `${name} (${def.type}): ${def.description}`)
    .join('; ');
  const outcomesSummary = capability.knownOutcomes.length
    ? ` May also return a known business outcome instead of these outputs: ${capability.knownOutcomes.map((o) => `${o.code} (${o.description})`).join('; ')}.`
    : '';

  return {
    name: toToolName(capability.capabilityId, capability.version),
    description: `${capability.description} Returns: ${outputsSummary}.${outcomesSummary}`,
    input_schema: {
      type: 'object',
      properties,
      required,
    },
  };
}

/**
 * Loads every artifact in a capabilities directory and exposes only
 * those approved for unattended agent invocation -- draft artifacts
 * don't make it into the catalog. This is the same status gate
 * scripts/replay-tenant.ts uses before binding a capability across
 * tenants: an unreviewed capability isn't something an agent gets handed
 * either.
 */
export function loadCatalog(capabilitiesDir: string): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const file of readdirSync(capabilitiesDir)) {
    if (!file.endsWith('.json') || file === 'schema.json') continue;
    const raw = JSON.parse(readFileSync(join(capabilitiesDir, file), 'utf-8'));
    const parsed = CapabilityDefinitionSchema.safeParse(raw);
    if (!parsed.success) continue;
    const capability = parsed.data;
    if (capability.status !== 'verified' && capability.status !== 'approved') continue;
    if (!capability.executionModes.includes('UNATTENDED')) continue;
    entries.push({ capability, toolName: toToolName(capability.capabilityId, capability.version), toolDefinition: toToolDefinition(capability) });
  }
  return entries;
}

export function findByToolName(catalog: CatalogEntry[], toolName: string): CatalogEntry | undefined {
  return catalog.find((e) => e.toolName === toolName);
}
