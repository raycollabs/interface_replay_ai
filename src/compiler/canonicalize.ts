/**
 * Route canonicalization: /member/12345/accounts -> /member/:memberId/accounts.
 *
 * Mechanical, not model-guessed -- the compiler already has the exact
 * input VALUES used during its own live replay (compileInputs), so
 * "is this URL segment one of our input values" is an exact-match
 * lookup, not a heuristic guess at what "looks like an identifier".
 * This is deliberately narrower than a generic ID-shape detector (no
 * regex guessing that a numeric segment is probably an ID) -- it only
 * ever replaces a segment that is EXACTLY a value the capability itself
 * supplied, so it can't accidentally canonicalize an unrelated numeric
 * path segment that just happens to look similar.
 */
export function canonicalizeRoute(url: string, inputs: Record<string, unknown>): string {
  const pathname = new URL(url).pathname;

  const valueToParam = new Map<string, string>();
  for (const [name, value] of Object.entries(inputs)) {
    if (value === undefined || value === null || value === '') continue;
    valueToParam.set(String(value), name);
  }

  const canonicalSegments = pathname.split('/').map((segment) => {
    const paramName = valueToParam.get(segment);
    return paramName ? `:${paramName}` : segment;
  });

  return canonicalSegments.join('/') || '/';
}
