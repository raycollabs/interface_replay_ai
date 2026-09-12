import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { DISCOVERY_TOOLS } from './actions.js';
import type { ObservedControl } from './setOfMarks.js';

/**
 * Sonnet 5 at high reasoning effort for every discovery API call -- not
 * Opus, not a cheaper model, per explicit instruction. This is also the
 * pragmatic choice architecturally: discovery is compiled away by Slice
 * 7 into a deterministic artifact and never runs again, so model choice
 * here trades off exploration quality against per-run cost, not
 * production latency.
 */
const MODEL_ID = 'claude-sonnet-5';

export interface DiscoveryContext {
  goal: string;
  /** Declared input NAMES only -- never their values. The model is told
   *  "there is an input called memberId you may reference as
   *  {{inputs.memberId}}"; it never sees "12345". */
  inputNames: string[];
  screenshotPath: string;
  controls: ObservedControl[];
  stepNumber: number;
  maxSteps: number;
}

function controlInventoryText(controls: ObservedControl[]): string {
  return controls
    .map((c) => {
      const frame = c.framePath.length ? ` [inside frame: ${c.framePath.join(' > ')}]` : '';
      const badge = c.badged ? '' : ' (not visually badged -- inside a frame)';
      return `#${c.mark} <${c.tag}> role=${c.role} name="${c.accessibleName}"${frame}${badge}`;
    })
    .join('\n');
}

export function buildSystemPrompt(inputNames: string[]): string {
  return `You are operating a legacy internal banking web application on behalf of an AI agent. You interact ONLY through the provided tools -- there is no way to run arbitrary code or navigate outside what the tools allow.

Declared inputs for this run (names only -- you are never shown their actual values): ${inputNames.length ? inputNames.join(', ') : '(none)'}.
When typing one of these into a field, use the exact placeholder syntax {{inputs.NAME}} as the value, e.g. {{inputs.memberId}}. It will be substituted with the real value below the point where anything you say is logged.

Each turn you are shown a screenshot with numbered badges over interactive controls in the main page, plus a text inventory of ALL interactive controls (including ones inside frames, which are not visually badged but are listed with their frame name). Refer to controls ONLY by their mark number using the click/type/extract tools.

Call exactly one tool per turn. If the goal is achieved, call finish(success=true, outputs={...}, summary=...) with any values you were asked to read. If you determine the goal cannot be completed, call finish(success=false, ...). If you hit something you should not decide alone (an unfamiliar dialog, an action that looks irreversible, anything ambiguous), call request_human instead of guessing.

You have a limited number of steps. Be direct: observe what's on screen, take the action that makes progress, don't repeat an action that already had no effect.`;
}

function buildObservationText(ctx: DiscoveryContext): string {
  return `Goal: ${ctx.goal}
Step ${ctx.stepNumber} of at most ${ctx.maxSteps}.

Interactive controls currently on screen:
${controlInventoryText(ctx.controls) || '(none found)'}`;
}

export interface DiscoveryDecision {
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  /** Short operational summary only -- never the model's full raw
   *  reasoning/chain-of-thought. Kept for the trace's MODEL_DECISION
   *  event, per the "don't persist chain-of-thought" rule. */
  shortRationale: string;
}

export class DiscoveryModel {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  private systemPrompt: string;

  constructor(apiKey: string, inputNames: string[]) {
    this.client = new Anthropic({ apiKey });
    this.systemPrompt = buildSystemPrompt(inputNames);
  }

  /** Adds this turn's observation (text + screenshot) as a user message,
   *  then truncates older screenshots to keep context/cost bounded --
   *  only the most recent 2 turns keep their actual image; earlier turns
   *  degrade to a text-only marker. Combined with prompt caching on the
   *  static system prompt + tool definitions, this is what keeps a
   *  15-step run affordable. */
  private pushObservation(ctx: DiscoveryContext): void {
    const imageBytes = readFileSync(ctx.screenshotPath);
    const base64 = imageBytes.toString('base64');

    this.messages.push({
      role: 'user',
      content: [
        { type: 'text', text: buildObservationText(ctx) },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
      ],
    });

    const IMAGE_RETENTION = 2;
    let imageMessagesSeen = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]!;
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      const hasImage = msg.content.some((b) => b.type === 'image');
      if (!hasImage) continue;
      imageMessagesSeen++;
      if (imageMessagesSeen > IMAGE_RETENTION) {
        msg.content = msg.content.filter((b) => b.type !== 'image');
        msg.content.push({ type: 'text', text: '[earlier screenshot omitted to bound context -- inventory text above still reflects that turn]' });
      }
    }
  }

  private pushToolResult(toolUseId: string, resultText: string): void {
    this.messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: resultText }],
    });
  }

  /** Records the assistant's own turn (including its tool_use block) so
   *  the next tool_result can reference it -- required by the API's
   *  message-alternation rules. */
  private pushAssistantTurn(content: Anthropic.ContentBlock[]): void {
    this.messages.push({ role: 'assistant', content });
  }

  async decide(ctx: DiscoveryContext, priorToolResult?: string, priorToolUseId?: string): Promise<DiscoveryDecision> {
    if (priorToolResult !== undefined && priorToolUseId !== undefined) {
      this.pushToolResult(priorToolUseId, priorToolResult);
    }
    this.pushObservation(ctx);

    const response = await this.client.messages.create({
      model: MODEL_ID,
      max_tokens: 1024,
      system: [{ type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: DISCOVERY_TOOLS.map((t, i) => (i === DISCOVERY_TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t)),
      tool_choice: { type: 'any' },
      messages: this.messages,
    });

    this.pushAssistantTurn(response.content);

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!toolUse) {
      throw new Error('Model responded without a tool call despite tool_choice: any.');
    }
    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');

    return {
      toolName: toolUse.name,
      toolInput: toolUse.input,
      toolUseId: toolUse.id,
      shortRationale: (textBlock?.text ?? '').slice(0, 300),
    };
  }
}
