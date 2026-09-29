import { describe, expect, it } from 'vitest';
import { triageExecution } from '../src/execution-triage.js';

describe('execution triage', () => {
  it('classifies timeout, assertion, and infrastructure evidence deterministically', () => {
    expect(triageExecution({ timedOut: true, exitCode: null, stdout: '', stderr: '' }).category).toBe('timeout');
    expect(triageExecution({ timedOut: false, exitCode: 1, stdout: '', stderr: 'AssertionError: expected true' }).category).toBe('assertion-failure');
    expect(triageExecution({ timedOut: false, exitCode: 1, stdout: '', stderr: 'ECONNREFUSED' }).category).toBe('infrastructure-failure');
  });
});
