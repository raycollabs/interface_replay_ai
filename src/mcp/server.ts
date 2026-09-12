import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadCatalog, type CatalogEntry } from '../catalog/index.js';
import { replay } from '../replay/engine.js';
import type { PolicyContext } from '../policy/allowlist.js';
import type { CapabilityDefinition } from '../contracts/index.js';
import type { Page } from 'playwright';

/**
 * Genuine MCP, not a look-alike: built on the official
 * @modelcontextprotocol/sdk, speaking real `tools/list` and `tools/call`
 * JSON-RPC methods. This is the model-vendor-neutral surface for the
 * capability catalog -- any MCP-compatible client (not just the
 * Anthropic SDK path scripts/catalog-demo.ts uses) can discover and
 * invoke these capabilities the same way.
 *
 * Tool registration takes each capability's `inputs` (already the typed
 * contract used everywhere else in this repo) and turns it into a Zod
 * raw shape -- MCP's registerTool wants that, not the JSON Schema
 * src/catalog/index.ts's Anthropic-facing toToolDefinition() produces.
 * Both are generated from the SAME CapabilityDefinition; neither is a
 * second hand-maintained schema.
 */

function toZodShape(inputs: CapabilityDefinition['inputs']): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, def] of Object.entries(inputs)) {
    let schema: z.ZodTypeAny =
      def.type === 'number' ? z.number() : def.type === 'boolean' ? z.boolean() : z.string();
    if (def.type === 'string' && def.pattern) schema = (schema as z.ZodString).regex(new RegExp(def.pattern));
    if (def.example) schema = schema.describe(`Example: ${def.example}`);
    if (!def.required) schema = schema.optional();
    shape[name] = schema;
  }
  return shape;
}

export interface McpServerDeps {
  capabilitiesDir: string;
  bootstrapSession: (page: Page, baseUrl: string) => Promise<void>;
}

export function buildMcpServer(deps: McpServerDeps): { server: McpServer; catalog: CatalogEntry[] } {
  const catalog = loadCatalog(deps.capabilitiesDir);

  const server = new McpServer({ name: 'interface-replay-catalog', version: '1.0.0' });

  for (const entry of catalog) {
    const { capability } = entry;
    server.registerTool(
      entry.toolName,
      {
        title: `${capability.capabilityId}@${capability.version}`,
        description: entry.toolDefinition.description,
        inputSchema: toZodShape(capability.inputs),
      },
      async (args: Record<string, unknown>) => {
        const baseUrl = capability.scope.allowedOrigins[0]!;
        const policyCtx: PolicyContext = {
          allowlist: {
            allowedOrigins: capability.scope.allowedOrigins,
            allowedRoutes: capability.scope.allowedRoutes,
            allowedActionTypes: capability.scope.allowedActionTypes,
            unattendedRiskCeiling: 'safe_reversible',
          },
          mode: 'UNATTENDED',
        };
        const evidenceDir = `evidence/mcp-invocation-${Date.now()}`;
        const result = await replay(
          capability,
          args,
          policyCtx,
          { evidenceDir, mode: 'UNATTENDED', headless: true },
          (page) => deps.bootstrapSession(page, baseUrl),
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  return { server, catalog };
}
