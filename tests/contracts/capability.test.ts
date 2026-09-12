import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CapabilityDefinitionSchema,
  ConditionSchema,
  ExecutionResultSchema,
  RunStateSchema,
} from '../../src/contracts/index.js';

function loadSample() {
  const path = fileURLToPath(
    new URL('../../capabilities/member.read-savings-balance.v1.json', import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('CapabilityDefinitionSchema', () => {
  it('accepts the hand-written sample artifact', () => {
    const result = CapabilityDefinitionSchema.safeParse(loadSample());
    expect(result.success).toBe(true);
  });

  it('rejects an artifact missing the checkpoint (the success condition is required)', () => {
    const sample = loadSample();
    delete sample.checkpoint;
    const result = CapabilityDefinitionSchema.safeParse(sample);
    expect(result.success).toBe(false);
  });

  it('rejects a step missing riskClass', () => {
    const sample = loadSample();
    delete sample.steps[0].riskClass;
    const result = CapabilityDefinitionSchema.safeParse(sample);
    expect(result.success).toBe(false);
  });

  it('rejects a target whose semanticPurpose is not in the closed vocabulary', () => {
    const sample = loadSample();
    sample.steps[1].target.semanticPurpose = 'some made up purpose';
    const result = CapabilityDefinitionSchema.safeParse(sample);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown action type (closed enum, not free text)', () => {
    const sample = loadSample();
    sample.steps[0].action = 'doubleClick';
    const result = CapabilityDefinitionSchema.safeParse(sample);
    expect(result.success).toBe(false);
  });

  it('requires at least one step', () => {
    const sample = loadSample();
    sample.steps = [];
    const result = CapabilityDefinitionSchema.safeParse(sample);
    expect(result.success).toBe(false);
  });
});

describe('ConditionSchema', () => {
  it('accepts a leaf condition', () => {
    const result = ConditionSchema.safeParse({
      type: 'controlVisible',
      semanticPurpose: 'account balance field',
    });
    expect(result.success).toBe(true);
  });

  it('accepts nested all/any composition (recursive schema resolves)', () => {
    const result = ConditionSchema.safeParse({
      type: 'any',
      conditions: [
        { type: 'controlVisible', semanticPurpose: 'accounts navigation' },
        { type: 'controlVisible', semanticPurpose: 'member not found banner' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a string-typed condition (conditions must be structured, not free text)', () => {
    const result = ConditionSchema.safeParse("page contains 'Account Summary'");
    expect(result.success).toBe(false);
  });
});

describe('ExecutionResultSchema', () => {
  it('accepts all four result arms', () => {
    const cases = [
      { status: 'success', outputs: { balance: 100 }, evidenceRef: 'run-1' },
      {
        status: 'business_outcome',
        code: 'MEMBER_NOT_FOUND',
        stepId: 'submit-search',
        message: 'No member matched.',
        evidenceRef: 'run-2',
      },
      {
        status: 'needs_human',
        runId: 'run-3',
        interventionId: 'int-1',
        reasonCode: 'UNKNOWN_DIALOG',
        evidenceRef: 'run-3',
      },
      {
        status: 'failure',
        code: 'TARGET_NOT_RESOLVED',
        stepId: 'open-accounts',
        expected: 'Accounts navigation control',
        observed: 'No unique target matched declared strategies.',
        evidenceRef: 'run-4',
      },
    ];
    for (const c of cases) {
      expect(ExecutionResultSchema.safeParse(c).success).toBe(true);
    }
  });

  it('rejects a three-arm-shaped result missing runId on needs_human', () => {
    const result = ExecutionResultSchema.safeParse({
      status: 'needs_human',
      interventionId: 'int-1',
      reasonCode: 'UNKNOWN_DIALOG',
      evidenceRef: 'run-3',
    });
    expect(result.success).toBe(false);
  });
});

describe('RunStateSchema', () => {
  it('accepts NONE as a control owner (the transitional/crash state)', () => {
    const result = RunStateSchema.safeParse({
      runId: 'run-1',
      capabilityId: 'member.read-savings-balance',
      capabilityVersion: 1,
      inputs: { memberId: '12345' },
      cursor: 2,
      status: 'SUSPENDED_AWAITING_HUMAN',
      mode: 'ATTENDED',
      lease: { owner: 'NONE', leaseId: null, heldSince: null, ttlMs: 300000 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects PAUSED as a status value (status and ownership are separate axes)', () => {
    const result = RunStateSchema.safeParse({
      runId: 'run-1',
      capabilityId: 'member.read-savings-balance',
      capabilityVersion: 1,
      inputs: {},
      cursor: 0,
      status: 'PAUSED',
      mode: 'ATTENDED',
      lease: { owner: 'AUTOMATION', leaseId: null, heldSince: null, ttlMs: 300000 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});
