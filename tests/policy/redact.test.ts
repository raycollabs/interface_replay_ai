import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CapabilityDefinitionSchema } from '../../src/contracts/index.js';
import { redact, sensitiveInputNames, sensitiveTargetPurposes, sensitiveValuesFor } from '../../src/policy/redact.js';

function loadSample() {
  const path = fileURLToPath(
    new URL('../../capabilities/member.read-savings-balance.v1.json', import.meta.url),
  );
  return CapabilityDefinitionSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

describe('redact', () => {
  it('replaces a known sensitive value wherever it appears in serialized data', () => {
    const data = { stepId: 'enter-member-id', value: '12345', note: 'typed 12345 into field' };
    const out = redact(data, ['12345']);
    expect(JSON.stringify(out)).not.toContain('12345');
    expect(out.value).toBe('[REDACTED]');
    expect(out.note).toBe('typed [REDACTED] into field');
  });

  it('is a no-op when there are no sensitive values', () => {
    const data = { stepId: 'navigate-search' };
    expect(redact(data, [])).toEqual(data);
  });

  it('identifies memberId as a sensitive input on the sample capability', () => {
    const capability = loadSample();
    expect(sensitiveInputNames(capability)).toEqual(['memberId']);
  });

  it('identifies "member identifier input" as the sensitive-bound target purpose', () => {
    const capability = loadSample();
    expect(sensitiveTargetPurposes(capability)).toEqual(['member identifier input']);
  });

  it('extracts runtime sensitive values for a given input bundle', () => {
    const capability = loadSample();
    expect(sensitiveValuesFor(capability, { memberId: '12345' })).toEqual(['12345']);
  });
});
