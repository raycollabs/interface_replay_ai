import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * The bounded action vocabulary. This is the only thing the model can
 * ever do -- there is no "run arbitrary JavaScript" tool, no free-form
 * navigation outside what perform() will policy-check anyway. Every
 * action is schema-validated (Anthropic's tool_choice: {type:'any'}
 * forces a tool call every turn, not free text) before it ever reaches
 * PlaywrightSurfaceAdapter.
 */
export const DiscoveryActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), route: z.string() }),
  z.object({ action: z.literal('click'), mark: z.number().int() }),
  z.object({
    action: z.literal('type'),
    mark: z.number().int(),
    /** May be a literal (e.g. selecting a dropdown option that's part of
     *  the flow's identity) or a `{{inputs.NAME}}` placeholder -- the
     *  model is told about declared inputs by name only, never their
     *  actual values (see buildSystemPrompt). Substituted at the surface
     *  boundary, same mechanism as deterministic replay. */
    value: z.string(),
  }),
  z.object({ action: z.literal('extract'), mark: z.number().int() }),
  z.object({
    action: z.literal('finish'),
    success: z.boolean(),
    outputs: z.record(z.string()).default({}),
    summary: z.string(),
  }),
  z.object({ action: z.literal('request_human'), reason: z.string() }),
]);
export type DiscoveryAction = z.infer<typeof DiscoveryActionSchema>;

/**
 * Hand-written Anthropic tool definitions (not zod-to-json-schema'd, like
 * the capability artifact is) -- these are deliberately simpler, flatter
 * shapes than the discriminated union above, because a tool-use schema
 * that's easy for the model to fill in correctly matters more here than
 * DRY-ing it against DiscoveryActionSchema. DiscoveryActionSchema is the
 * validation gate every tool call is checked against after the model
 * responds, regardless of how the tool was declared to it.
 */
export const DISCOVERY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'navigate',
    description: 'Navigate to a route on the target app (e.g. "/member-search").',
    input_schema: {
      type: 'object',
      properties: { route: { type: 'string' } },
      required: ['route'],
    },
  },
  {
    name: 'click',
    description: 'Click the control at the given mark number (from the numbered badges in the screenshot, or the text inventory for unbadged controls inside frames).',
    input_schema: {
      type: 'object',
      properties: { mark: { type: 'integer' } },
      required: ['mark'],
    },
  },
  {
    name: 'type',
    description: 'Type a value into the control at the given mark number. Use a {{inputs.NAME}} placeholder to reference a declared input -- you are never shown its actual value.',
    input_schema: {
      type: 'object',
      properties: { mark: { type: 'integer' }, value: { type: 'string' } },
      required: ['mark', 'value'],
    },
  },
  {
    name: 'extract',
    description: 'Read the text content of the control at the given mark number. The result is returned to you so you can report it in finish().',
    input_schema: {
      type: 'object',
      properties: { mark: { type: 'integer' } },
      required: ['mark'],
    },
  },
  {
    name: 'finish',
    description: 'Declare the goal complete (or definitively not achievable) and stop the run.',
    input_schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        outputs: { type: 'object', description: 'Named values extracted during the run, e.g. {"balance": "4235.67"}.' },
        summary: { type: 'string' },
      },
      required: ['success', 'summary'],
    },
  },
  {
    name: 'request_human',
    description: 'Stop and ask for a human, because you cannot safely or confidently proceed (e.g. an unfamiliar dialog, an ambiguous choice, a risky action).',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
];
