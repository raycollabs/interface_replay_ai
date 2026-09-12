import { z } from 'zod';
import { SEMANTIC_PURPOSES } from './semanticPurposes.js';

const SemanticPurposeSchema = z.enum(SEMANTIC_PURPOSES);

/**
 * A structured, surface-agnostic predicate — never a free-form expression
 * string. This is what makes pre/postconditions and checkpoints portable to
 * a desktop adapter later: `controlVisible` compiles to a DOM query today
 * and a UIA element lookup tomorrow, without the condition itself changing.
 *
 * A string-typed condition (`"page contains 'Account Summary'"`) would force
 * either `eval`-like interpretation (unsafe, and couples the schema to one
 * surface) or an undocumented expression DSL. Neither survives the
 * heterogeneity requirement.
 */
export type Condition =
  | { type: 'textVisible'; value: string }
  | { type: 'textAbsent'; value: string }
  | { type: 'controlVisible'; semanticPurpose: string }
  | { type: 'controlAbsent'; semanticPurpose: string }
  | { type: 'controlHasValue'; semanticPurpose: string; equals: string }
  | { type: 'urlMatches'; pattern: string }
  | { type: 'all'; conditions: Condition[] }
  | { type: 'any'; conditions: Condition[] };

// z.lazy() cannot infer its own return type, so the explicit z.ZodType<Condition>
// annotation is required to close the recursive loop (all/any reference Condition).
export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('textVisible'), value: z.string().min(1) }),
    z.object({ type: z.literal('textAbsent'), value: z.string().min(1) }),
    z.object({ type: z.literal('controlVisible'), semanticPurpose: SemanticPurposeSchema }),
    z.object({ type: z.literal('controlAbsent'), semanticPurpose: SemanticPurposeSchema }),
    z.object({
      type: z.literal('controlHasValue'),
      semanticPurpose: SemanticPurposeSchema,
      /** May contain `{{inputs.NAME}}` placeholders, substituted against
       *  the run's actual input values at evaluation time (see
       *  src/surface/placeholders.ts) — this is how a postcondition can
       *  assert "the field now holds what we typed" without the artifact
       *  itself ever containing a real input value. */
      equals: z.string(),
    }),
    z.object({ type: z.literal('urlMatches'), pattern: z.string().min(1) }),
    z.object({ type: z.literal('all'), conditions: z.array(ConditionSchema).min(1) }),
    z.object({ type: z.literal('any'), conditions: z.array(ConditionSchema).min(1) }),
  ]),
);
