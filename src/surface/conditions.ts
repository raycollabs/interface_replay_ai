import type { Page } from 'playwright';
import type { Condition, Target } from '../contracts/index.js';
import { resolveTarget } from './resolveTarget.js';
import { substitutePlaceholders } from './placeholders.js';

/**
 * Evaluates a structured Condition against the live page. This is what
 * replay waits on instead of sleeping — every precondition, postcondition,
 * and the checkpoint itself all go through this one evaluator, so "wait
 * for the postcondition" and "check the checkpoint" are the same
 * mechanism, not two.
 */
export async function checkCondition(
  page: Page,
  condition: Condition,
  targetRegistry: Record<string, Target>,
  inputs: Record<string, unknown>,
): Promise<boolean> {
  switch (condition.type) {
    case 'textVisible': {
      const loc = page.getByText(condition.value, { exact: false }).first();
      return (await loc.count()) > 0 && (await loc.isVisible().catch(() => false));
    }
    case 'textAbsent': {
      const loc = page.getByText(condition.value, { exact: false }).first();
      const count = await loc.count();
      if (count === 0) return true;
      return !(await loc.isVisible().catch(() => false));
    }
    case 'controlVisible': {
      const target = targetRegistry[condition.semanticPurpose];
      if (!target) return false;
      const resolution = await resolveTarget(page, target);
      if (resolution.outcome !== 'resolved') return false;
      return resolution.locator.isVisible().catch(() => false);
    }
    case 'controlAbsent': {
      const target = targetRegistry[condition.semanticPurpose];
      if (!target) return true; // nothing registered to be visible
      const resolution = await resolveTarget(page, target);
      if (resolution.outcome !== 'resolved') return true;
      return !(await resolution.locator.isVisible().catch(() => false));
    }
    case 'controlHasValue': {
      const target = targetRegistry[condition.semanticPurpose];
      if (!target) return false;
      const resolution = await resolveTarget(page, target);
      if (resolution.outcome !== 'resolved') return false;
      const actual = await resolution.locator.inputValue().catch(() => null);
      const expected = substitutePlaceholders(condition.equals, inputs);
      return actual === expected;
    }
    case 'urlMatches':
      return new RegExp(condition.pattern).test(page.url());
    case 'all': {
      for (const c of condition.conditions) {
        if (!(await checkCondition(page, c, targetRegistry, inputs))) return false;
      }
      return true;
    }
    case 'any': {
      for (const c of condition.conditions) {
        if (await checkCondition(page, c, targetRegistry, inputs)) return true;
      }
      return false;
    }
  }
}

/**
 * Polls a condition until it holds or the timeout elapses. This is the
 * ONLY form of waiting in the replay path — there are no unconditional
 * sleeps anywhere. A short poll interval keeps failures fast without
 * busy-looping.
 */
export async function waitForCondition(
  page: Page,
  condition: Condition,
  targetRegistry: Record<string, Target>,
  inputs: Record<string, unknown>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pollMs = 150;
  for (;;) {
    if (await checkCondition(page, condition, targetRegistry, inputs)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
