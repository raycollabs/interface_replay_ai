import { z } from 'zod';
import { SEMANTIC_PURPOSES } from './semanticPurposes.js';

const SemanticPurposeSchema = z.enum(SEMANTIC_PURPOSES);

/**
 * The targeting ladder. Each variant is a distinct, typed way to find a
 * control — not a generic `{key: value}` bag. Typing the payload per
 * strategy is what makes each rung's portability claim checkable: rungs 2/3
 * map directly onto an OS accessibility API; `visible_text` and any future
 * coordinate-based rung do not, and a compiler can flag that mechanically
 * instead of by convention.
 *
 * Coordinates are deliberately NOT a strategy here. They may exist as a
 * discovery-time convenience inside the agent loop, but the compiler refuses
 * to emit a coordinate-only target into an artifact (see compiler/uniqueness
 * checks in Slice 7) — a coordinate in a capability artifact is exactly the
 * failure mode this schema exists to prevent.
 */
export const StrategySchema = z.discriminatedUnion('type', [
  // Rung 1 — rare in legacy apps, checked first when present.
  z.object({ type: z.literal('semantic_id'), id: z.string() }),

  // Rung 2 — the load-bearing rung: portable to a desktop UIA/AX adapter
  // via (ControlType, Name) with no change to this schema.
  z.object({
    type: z.literal('role_and_name'),
    role: z.string(),
    name: z.string(),
    exact: z.boolean().default(true),
  }),

  // Rung 3 — explicit <label for> or nearest-preceding-label heuristic.
  z.object({ type: z.literal('associated_label'), label: z.string() }),

  // Rung 5 — for table-layout legacy markup, a row/column header pair is
  // often the most semantically stable locator on the page even though it
  // has no desktop analogue as written (a desktop grid control would need
  // its own row/column addressing).
  z.object({
    type: z.literal('structural_semantic'),
    rowHeader: z.string(),
    columnHeader: z.string(),
  }),

  // Rung 6 — relative to a stable text anchor.
  z.object({
    type: z.literal('text_anchor'),
    anchorText: z.string(),
    relationship: z.enum(['first-input-below', 'same-row', 'next-sibling']),
  }),

  // Rung 7 — last resort before the compiler refuses. Flagged nonPortable.
  z.object({ type: z.literal('visible_text'), text: z.string() }),
]);

export type Strategy = z.infer<typeof StrategySchema>;

export const TargetCandidateSchema = z.object({
  strategy: StrategySchema,
  /** Why the compiler believes this strategy is robust for this control. */
  rationale: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const TargetSchema = z.object({
  /**
   * The control's stable identity — this is the tenant-override merge key,
   * NOT a property of any one strategy. A control has one semantic purpose
   * and several competing ways (strategies) to find it.
   */
  semanticPurpose: SemanticPurposeSchema,
  /**
   * Frame context applies to ALL candidate strategies for this control, not
   * just structural_semantic ones — a role_and_name lookup inside an
   * iframe still has to switch into that frame first. Empty array means
   * the top-level document. Named by iframe `name`/`id`, outermost first.
   */
  framePath: z.array(z.string()).default([]),
  /** Ordered by preference; resolver tries candidates in order. */
  candidates: z.array(TargetCandidateSchema).min(1),
  /** Which rung matched at record/compile time — the drift-telemetry signal. */
  recordedRung: z.number().int().min(0),
});

export type Target = z.infer<typeof TargetSchema>;
