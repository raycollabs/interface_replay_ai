import { chromium, type Browser, type BrowserServer, type BrowserContext, type Page } from 'playwright';
import type { CapabilityDefinition, CapabilityStep } from '../contracts/index.js';
import { evaluatePolicy, type PolicyContext } from '../policy/allowlist.js';
import { resolveTarget } from './resolveTarget.js';
import { substitutePlaceholders } from './placeholders.js';

export type PerformOutcome =
  | { kind: 'policy_denied'; reason: string }
  | { kind: 'require_human'; reason: string }
  | { kind: 'frame_not_found'; framePath: string[] }
  | { kind: 'target_not_resolved' }
  | { kind: 'target_ambiguous'; matchedStrategyType: string; count: number }
  | { kind: 'no_target_declared' }
  | { kind: 'executed'; extractedText?: string; matchedRung?: number };

function resolveValue(step: CapabilityStep, inputs: Record<string, unknown>): string {
  if (!step.value) return '';
  if ('literal' in step.value) return step.value.literal;
  // paramRef: the real value crosses from "declared input" to "live value"
  // right here, at the surface boundary -- below wherever a caller of
  // perform() might log the step it just asked for.
  return String(inputs[step.value.paramRef] ?? '');
}

/**
 * The out-of-process browser is launched via launchServer()+connect() from
 * this first adapter commit, not retrofitted later: a second client (an
 * operator console, in Slice 5) can attach to the same wsEndpoint and
 * drive the identical live session without anything here changing. Built
 * now because the alternative -- an in-process `chromium.launch()` -- has
 * no seam for a second client to attach to, and adding one after replay
 * code already assumes a single owner would be a rewrite, not an addition.
 */
export class PlaywrightSurfaceAdapter {
  private server: BrowserServer | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly options: { headless?: boolean } = {},
  ) {}

  get wsEndpoint(): string | null {
    return this.server?.wsEndpoint() ?? null;
  }

  getPage(): Page {
    if (!this.page) throw new Error('Adapter not launched yet.');
    return this.page;
  }

  async launch(): Promise<void> {
    this.server = await chromium.launchServer({ headless: this.options.headless ?? true });
    this.browser = await chromium.connect(this.server.wsEndpoint());
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    await this.server?.close().catch(() => {});
  }

  private currentRoute(): string {
    try {
      return new URL(this.page!.url()).pathname;
    } catch {
      return '/';
    }
  }

  /**
   * The sole entry point to the live surface. `policy.evaluate()` is
   * called from inside this method, before anything touches the page --
   * there is no other function in this class (or anywhere above it) that
   * reaches the browser. That placement is the structural guarantee:
   * neither the discovery loop nor the replay engine has a path around
   * policy, because the only door in has the check built into its frame.
   */
  async perform(
    step: CapabilityStep,
    capability: CapabilityDefinition,
    inputs: Record<string, unknown>,
    policyCtx: PolicyContext,
  ): Promise<PerformOutcome> {
    const page = this.getPage();

    if (step.action === 'navigate') {
      const route = resolveValue(step, inputs);
      const targetUrl = new URL(route, this.baseUrl).toString();
      const decision = evaluatePolicy(
        { actionType: 'navigate', targetUrl, route, riskClass: step.riskClass },
        policyCtx,
      );
      if (decision.decision === 'deny') return { kind: 'policy_denied', reason: decision.reason };
      if (decision.decision === 'require_human') return { kind: 'require_human', reason: decision.reason };
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      return { kind: 'executed' };
    }

    if (step.action === 'wait') {
      // No target, no unconditional sleep here either -- callers wait via
      // waitForCondition() against the step's own postcondition instead.
      return { kind: 'executed' };
    }

    if (!step.targetPurpose) return { kind: 'no_target_declared' };
    const target = capability.targetRegistry[step.targetPurpose];
    if (!target) return { kind: 'no_target_declared' };

    const decision = evaluatePolicy(
      { actionType: step.action, route: this.currentRoute(), riskClass: step.riskClass },
      policyCtx,
    );
    if (decision.decision === 'deny') return { kind: 'policy_denied', reason: decision.reason };
    if (decision.decision === 'require_human') return { kind: 'require_human', reason: decision.reason };

    const resolution = await resolveTarget(page, target);
    if (resolution.outcome === 'frame_not_found') return { kind: 'frame_not_found', framePath: resolution.framePath };
    if (resolution.outcome === 'not_resolved') return { kind: 'target_not_resolved' };
    if (resolution.outcome === 'ambiguous') {
      return { kind: 'target_ambiguous', matchedStrategyType: resolution.matchedStrategyType, count: resolution.count };
    }

    switch (step.action) {
      case 'click':
        await resolution.locator.click();
        return { kind: 'executed', matchedRung: resolution.matchedRung };
      case 'type': {
        const rawValue = resolveValue(step, inputs);
        const value = substitutePlaceholders(rawValue, inputs);
        await resolution.locator.fill(value);
        return { kind: 'executed', matchedRung: resolution.matchedRung };
      }
      case 'select': {
        const value = resolveValue(step, inputs);
        await resolution.locator.selectOption(value);
        return { kind: 'executed', matchedRung: resolution.matchedRung };
      }
      case 'extract': {
        const text = (await resolution.locator.innerText()).trim();
        return { kind: 'executed', extractedText: text, matchedRung: resolution.matchedRung };
      }
      case 'assert':
        return { kind: 'executed', matchedRung: resolution.matchedRung };
      default:
        return { kind: 'executed' };
    }
  }
}
