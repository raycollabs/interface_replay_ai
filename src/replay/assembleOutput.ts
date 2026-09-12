import type { OutputDef } from '../contracts/index.js';

/**
 * Turns declared output shapes into real values from the extracted-by-
 * step map the engine already collected. Scalars and one level of
 * object nesting are genuinely produced here; `array` is representable
 * in the schema (OutputShapeSchema, contracts/capability.ts) but has no
 * producer -- there is no table-rows extraction primitive in this
 * project (a real, stated cut: see REPORT.md), so a capability that
 * declares one fails loudly and specifically at replay time rather than
 * silently returning an empty or wrong array.
 */
export function assembleOutput(def: OutputDef, extractedByStep: Record<string, string>): unknown {
  if (def.shape.type === 'object') {
    const result: Record<string, unknown> = {};
    for (const propName of Object.keys(def.shape.properties)) {
      const stepId = def.sourceStepsByProperty?.[propName];
      result[propName] = stepId !== undefined ? extractedByStep[stepId] : undefined;
    }
    return result;
  }
  if (def.shape.type === 'array') {
    throw new Error(
      `Output shape 'array' has no replay-time producer yet (no table-rows extraction primitive exists in this project). ` +
        `Declared but not implemented -- see REPORT.md's Cuts.`,
    );
  }
  // Scalar: string | number | boolean | decimal.
  return def.sourceStepId !== undefined ? extractedByStep[def.sourceStepId] : undefined;
}
