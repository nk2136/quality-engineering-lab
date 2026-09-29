import { describe, expect, it } from 'vitest';
import {
  MockCiSource,
  MockOpenApiSource,
  MockPostgresSource,
  MockTelemetrySource,
  draftDefects,
  summarizeFlakiness,
  summarizeReleaseRisk,
} from '../src/extended-analysis.js';

describe('deterministic extended analysis', () => {
  it('bounds mock database and API evidence to declared records', () => {
    const database = new MockPostgresSource({ active_users: [{ id: 1 }, { id: 2 }] });
    expect(database.query('active_users', 1)).toEqual([{ id: 1 }]);
    expect(() => database.query('select * from users', 1)).toThrow('not declared');
    expect(new MockOpenApiSource([{ operationId: 'checkEligibility', method: 'GET', path: '/eligibility' }]).operation('checkEligibility')).toMatchObject({ path: '/eligibility' });
  });

  it('derives flaky, defect, and release-risk evidence without release authority', () => {
    const ci = new MockCiSource([{ testId: 'eligibility', outcome: 'passed' }, { testId: 'eligibility', outcome: 'failed' }]);
    const telemetry = new MockTelemetrySource([{ traceId: 't1', message: 'Eligibility service returned 500' }]);
    expect(summarizeFlakiness(ci.runs())).toEqual([{ testId: 'eligibility', sampleSize: 2, failureRate: 0.5 }]);
    expect(draftDefects([{ signature: 'eligibility-500', evidence: telemetry.events()[0]!.message }])).toEqual([{ signature: 'eligibility-500', occurrences: 1, evidence: ['Eligibility service returned 500'] }]);
    expect(summarizeReleaseRisk({ blockers: ['Missing approval'], flaky: summarizeFlakiness(ci.runs()), defects: draftDefects([]) })).toMatchObject({ releaseAuthorized: false, level: 'high' });
  });
});
