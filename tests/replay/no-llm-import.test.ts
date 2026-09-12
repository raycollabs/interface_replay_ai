import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Structural enforcement of "the replay engine makes zero LLM decision
 * calls" -- not a runtime assertion (there is no LLM client installed at
 * all yet; that arrives in Slice 6), but a standing guard that will keep
 * failing this test the moment anyone imports one into the replay path
 * later, on purpose or by accident. The engine's own header comment says
 * why; this is what makes that comment enforceable rather than aspirational.
 */
const FORBIDDEN_IMPORT_PATTERNS = [/@anthropic-ai\/sdk/, /from ['"].*anthropic.*['"]/i];

function tsFilesUnder(dirUrl: URL): string[] {
  const dir = fileURLToPath(dirUrl);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `${dir}${f}`);
}

const files = [
  ...tsFilesUnder(new URL('../../src/replay/', import.meta.url)),
  ...tsFilesUnder(new URL('../../src/surface/', import.meta.url)),
  ...tsFilesUnder(new URL('../../src/policy/', import.meta.url)),
];

describe('replay engine has no LLM import anywhere in its decision path', () => {
  it('found source files to scan (guards against an empty/misconfigured glob passing vacuously)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s does not import an LLM client', (file) => {
    const contents = readFileSync(file, 'utf-8');
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      expect(contents).not.toMatch(pattern);
    }
  });
});
