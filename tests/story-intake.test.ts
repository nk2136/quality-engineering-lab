import { describe, expect, it } from 'vitest';
import type { ContextEvidence } from '../src/context.js';
import type { KnowledgeQuery, KnowledgeSource } from '../src/contracts.js';
import { InMemoryArtifactStore, InMemoryWorkflowStore } from '../src/in-memory-stores.js';
import {
  NonSdetAssignmentError,
  StoryIntakeRouter,
  UnsupportedStoryProviderError,
} from '../src/story-intake.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';
const assignment = {
  assignmentId: 'assignment-QE-42',
  traceId,
  provider: 'jira',
  issueKey: 'QE-42',
  workType: 'sdet' as const,
};

const evidence: ContextEvidence = {
  id: 'jira:10042:2026-10-15T18:00:00.000+0000',
  source: 'jira',
  uri: 'https://example.atlassian.net/browse/QE-42',
  revision: '2026-10-15T18:00:00.000+0000',
  retrievedAt: '2026-10-15T18:05:00.000Z',
  content: JSON.stringify({ key: 'QE-42', summary: 'Eligibility request' }),
  estimatedTokens: 10,
  relevance: 1,
};

class StubKnowledgeSource implements KnowledgeSource {
  calls: KnowledgeQuery[] = [];

  async search(query: KnowledgeQuery): Promise<readonly ContextEvidence[]> {
    this.calls.push(query);
    return [evidence];
  }
}

function router(source = new StubKnowledgeSource()) {
  const workflows = new InMemoryWorkflowStore();
  const artifacts = new InMemoryArtifactStore();
  return {
    source,
    workflows,
    artifacts,
    router: new StoryIntakeRouter({
      allowedIssueKeys: ['QE-42'],
    }, {
      knowledge: source,
      workflows,
      artifacts,
      now: () => '2026-10-15T18:05:00.000Z',
    }),
  };
}

describe('story assignment intake', () => {
  it('rejects non-SDET assignments before source I/O', async () => {
    const setup = router();

    await expect(setup.router.intake({ ...assignment, workType: 'product' })).rejects.toBeInstanceOf(
      NonSdetAssignmentError,
    );
    expect(setup.source.calls).toEqual([]);
  });

  it('rejects unsupported providers before source I/O', async () => {
    const setup = router();

    await expect(setup.router.intake({ ...assignment, provider: 'github' })).rejects.toBeInstanceOf(
      UnsupportedStoryProviderError,
    );
    expect(setup.source.calls).toEqual([]);
  });

  it('rejects issue keys outside the policy before source I/O', async () => {
    const setup = router();

    await expect(setup.router.intake({ ...assignment, issueKey: 'QE-43' })).rejects.toThrow(
      "Story 'QE-43' is not in the configured allowlist.",
    );
    expect(setup.source.calls).toEqual([]);
  });

  it('captures the source revision and routes an accepted assignment to refinement', async () => {
    const setup = router();

    const result = await setup.router.intake(assignment);

    expect(result).toMatchObject({
      assignmentId: assignment.assignmentId,
      storyKey: assignment.issueKey,
      provider: 'jira',
      revision: evidence.revision,
      workflow: { id: 'story-intake:assignment-QE-42', stage: 'refinement', status: 'pending' },
    });
    expect(setup.source.calls).toEqual([expect.objectContaining({
      text: 'QE-42',
      sources: ['jira'],
      asOf: '2026-10-15T18:05:00.000Z',
    })]);
    expect(await setup.artifacts.get('story-intake:assignment-QE-42')).toMatchObject({
      kind: 'requirement-analysis',
      content: expect.objectContaining({ revision: evidence.revision }),
    });
  });

  it('is idempotent and reuses the captured revision without a second source read', async () => {
    const setup = router();

    const first = await setup.router.intake(assignment);
    const second = await setup.router.intake(assignment);

    expect(second).toEqual(first);
    expect(setup.source.calls).toHaveLength(1);
  });

  it('coalesces concurrent intake requests for the same assignment', async () => {
    const setup = router();

    const results = await Promise.all([
      setup.router.intake(assignment),
      setup.router.intake(assignment),
    ]);

    expect(results[1]).toEqual(results[0]);
    expect(setup.source.calls).toHaveLength(1);
  });
});
