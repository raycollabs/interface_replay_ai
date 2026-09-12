/**
 * The one substitution point for `{{inputs.NAME}}` placeholders. Values are
 * bound as opaque placeholders in the artifact/condition text and resolved
 * to real runtime values only here, at the surface boundary — below
 * logging, tracing, and screenshot capture. This is what keeps a raw input
 * value (e.g. a member ID) out of anything derived from a run: the
 * artifact never contains it, and neither does an evidence log built from
 * data that passed through here.
 */
export function substitutePlaceholders(template: string, inputs: Record<string, unknown>): string {
  return template.replace(/\{\{inputs\.(\w+)\}\}/g, (_match, name: string) => {
    const value = inputs[name];
    return value === undefined || value === null ? '' : String(value);
  });
}
