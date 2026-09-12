import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { SEMANTIC_PURPOSES } from '../contracts/index.js';

const MODEL_ID = 'claude-sonnet-5';

export interface ActedControl {
  step: number;
  toolName: string;
  role: string;
  accessibleName: string;
  tag: string;
  framePath: string[];
}

export interface DeclaredOutputPurpose {
  name: string;
  semanticPurpose: (typeof SEMANTIC_PURPOSES)[number];
}

const ClassificationSchema = z.object({
  controlPurposes: z.array(
    z.object({
      step: z.number(),
      semanticPurpose: z.enum(SEMANTIC_PURPOSES),
      rationale: z.string(),
    }),
  ),
  checkpointPurposes: z.array(z.enum(SEMANTIC_PURPOSES)).min(1),
});
export type Classification = z.infer<typeof ClassificationSchema>;

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'propose_capability_semantics',
  description: 'Classify each acted-upon control against the closed semantic purpose vocabulary, and propose which purposes together constitute the success checkpoint.',
  input_schema: {
    type: 'object',
    properties: {
      controlPurposes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            step: { type: 'integer', description: 'The trace step number this control was acted on in.' },
            semanticPurpose: { type: 'string', enum: [...SEMANTIC_PURPOSES] },
            rationale: { type: 'string', description: 'One sentence: why this purpose fits.' },
          },
          required: ['step', 'semanticPurpose', 'rationale'],
        },
      },
      checkpointPurposes: {
        type: 'array',
        items: { type: 'string', enum: [...SEMANTIC_PURPOSES] },
        description: 'Purposes that, all being visible together, prove the goal was reached (e.g. the row/section that was being looked up, plus at least one output field).',
      },
    },
    required: ['controlPurposes', 'checkpointPurposes'],
  },
};

/**
 * The ONE LLM call in the compiler, scoped narrowly to the thing that
 * genuinely needs judgment: mapping a control the DISCOVERY run happened
 * to act on (the compiler didn't choose it) to the closed semantic
 * vocabulary, and proposing a checkpoint. Everything else -- output
 * locations, target strategy payloads, uniqueness -- is mechanical (see
 * tableLookup.ts and index.ts), because those don't need a model's
 * opinion, they need a DOM query. Fresh context: this call carries no
 * conversation history from discovery, only the structured facts it needs.
 */
export async function classifyCapability(
  apiKey: string,
  actedControls: ActedControl[],
  declaredOutputPurposes: DeclaredOutputPurpose[],
  goal: string,
): Promise<Classification> {
  const client = new Anthropic({ apiKey });

  const controlsText = actedControls
    .map((c) => `step ${c.step}: ${c.toolName} on <${c.tag}> role=${c.role} name="${c.accessibleName}"${c.framePath.length ? ` (in frame ${c.framePath.join('>')})` : ''}`)
    .join('\n');
  const outputsText = declaredOutputPurposes.map((o) => `${o.name} -> already assigned purpose "${o.semanticPurpose}"`).join('\n');

  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: 1024,
    tool_choice: { type: 'tool', name: 'propose_capability_semantics' },
    tools: [CLASSIFY_TOOL],
    messages: [
      {
        role: 'user',
        content: `A discovery run achieved this goal: "${goal}"

It acted on these controls, in order:
${controlsText}

The capability's declared outputs already have assigned semantic purposes (not your job to change):
${outputsText}

For each acted-upon control above, classify it against the closed semantic purpose vocabulary you have available as an enum. Then propose which purposes (from either the acted-upon controls or the declared outputs) together prove the goal was achieved -- this becomes the capability's checkpoint.`,
      },
    ],
  });

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) throw new Error('Classification call returned no tool use despite forced tool_choice.');

  return ClassificationSchema.parse(toolUse.input);
}
