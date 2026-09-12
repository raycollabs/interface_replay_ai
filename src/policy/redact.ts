import type { CapabilityDefinition } from '../contracts/index.js';

/** Names of inputs the capability declares `sensitive: true`. */
export function sensitiveInputNames(capability: CapabilityDefinition): string[] {
  return Object.entries(capability.inputs)
    .filter(([, def]) => def.sensitive)
    .map(([name]) => name);
}

/**
 * Redacts known sensitive literal values out of arbitrary serializable data
 * before it is ever written to a RunEvent, an artifact, or a screenshot
 * caption — i.e. redaction happens at the point of capture, not by
 * scrubbing logs after the fact. Redact-on-write means the raw value
 * already existed somewhere loggable in the meantime; this closes that gap
 * by being the only path data takes on its way into evidence.
 *
 * Deliberately a substring replace over the serialized form rather than a
 * key-name-based scrubber: it also catches a sensitive value that leaked
 * into an unrelated field (e.g. echoed back inside a validation-error
 * message). Known limitation: it only catches exact-value matches, not
 * partial fragments or values the app has reformatted (e.g. re-padded,
 * re-cased). Documented as a limit in REPORT.md's Safety section, not
 * silently assumed complete.
 */
export function redact<T>(data: T, sensitiveValues: readonly string[]): T {
  const nonEmpty = sensitiveValues.filter((v) => v && v.length > 0);
  if (nonEmpty.length === 0) return data;

  let json = JSON.stringify(data);
  for (const value of nonEmpty) {
    json = json.split(value).join('[REDACTED]');
  }
  return JSON.parse(json) as T;
}

/**
 * Which target purposes are bound to a sensitive input value anywhere in
 * the capability's steps (i.e. which on-screen controls display/hold a
 * sensitive value at some point during the run). This is what
 * captureEvidence uses to decide which controls to mask before taking a
 * screenshot — see src/surface/evidence.ts.
 */
export function sensitiveTargetPurposes(capability: CapabilityDefinition): string[] {
  const sensitiveInputs = new Set(sensitiveInputNames(capability));
  const purposes = new Set<string>();
  for (const step of capability.steps) {
    if (step.targetPurpose && step.value && 'paramRef' in step.value && sensitiveInputs.has(step.value.paramRef)) {
      purposes.add(step.targetPurpose);
    }
  }
  return [...purposes];
}

/** Extracts the runtime sensitive values for a given input bundle, for
 *  handing to redact(). E.g. sensitiveValuesFor(capability, {memberId: "12345"}) -> ["12345"]. */
export function sensitiveValuesFor(
  capability: CapabilityDefinition,
  inputs: Record<string, unknown>,
): string[] {
  return sensitiveInputNames(capability)
    .map((name) => inputs[name])
    .filter((v): v is string => typeof v === 'string');
}
