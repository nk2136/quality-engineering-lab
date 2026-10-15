import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProjectProfileNotFoundError,
  ProjectProfileSchema,
  loadProjectProfileDocument,
  parseProjectProfileMarkdown,
  validateProjectProfile,
} from '../src/project-profile.js';

const revision = 'a'.repeat(40);

function profile(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    project: { name: 'Eligibility', description: 'Eligibility service checks.' },
    architectureMap: [{ componentId: 'gateway', responsibility: 'Routes eligibility requests.', dependsOn: [] }],
    ticketSystem: {
      provider: 'jira',
      baseUrl: 'https://example.atlassian.net',
      issueKeyPattern: '^[A-Z][A-Z0-9_]*-\\d+$',
      accessMode: 'read-only',
    },
    components: [{ id: 'gateway', name: 'Gateway', responsibilities: ['Routes requests.'], repositoryIds: ['app'] }],
    repositories: [{
      id: 'app', provider: 'github', repository: 'acme/eligibility', revision,
      paths: ['src', 'tests'], accessMode: 'read-only',
    }],
    frameworkConventions: {
      language: 'typescript', testRunner: 'vitest', testFilePatterns: ['tests/**/*.test.ts'],
      sourceDirectory: 'src', testDirectory: 'tests',
      commands: [{ id: 'typecheck', command: 'npm run typecheck', tool: 'npm', readOnly: true }],
    },
    dataRules: {
      syntheticDataOnly: true, secretsAllowed: false, forbiddenData: ['production records'],
      allowedDataSources: ['fixtures', 'mocks', 'local-artifacts'],
    },
    reportingExport: { formats: ['json', 'markdown'], destinations: ['local-file', 'artifact-store'] },
    criticalChecks: [{ id: 'tests', command: 'npm test -- --run', tool: 'npm', readOnly: true }],
    hardRules: ['Use read-only provider access.', 'Never use production data.'],
    ...overrides,
  };
}

function markdown(value: unknown): string {
  return `# Story-to-test profile\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

describe('project profile', () => {
  it('validates the complete contract and preserves pinned read-only sources', () => {
    const result = validateProjectProfile(profile());
    expect(result.ticketSystem.accessMode).toBe('read-only');
    expect(result.repositories[0]?.revision).toBe(revision);
    expect(result.repositories[0]?.paths).toEqual(['src', 'tests']);
  });

  it('rejects missing required sections and stale schema fields', () => {
    const value = profile();
    delete (value as Record<string, unknown>).dataRules;
    expect(() => ProjectProfileSchema.parse(value)).toThrow();
    expect(() => validateProjectProfile({ ...profile(), schemaVersion: '0.9' })).toThrow();
    expect(() => validateProjectProfile({ ...profile(), staleField: 'old' })).toThrow();
  });

  it('rejects mutable or write-capable ticket and code access', () => {
    expect(() => validateProjectProfile({
      ...profile(), ticketSystem: { ...profile().ticketSystem, accessMode: 'read-write' },
    })).toThrow();
    expect(() => validateProjectProfile({
      ...profile(), repositories: [{ ...profile().repositories[0], accessMode: 'write' }],
    })).toThrow();
    expect(() => validateProjectProfile({
      ...profile(), repositories: [{ ...profile().repositories[0], revision: 'main' }],
    })).toThrow();
  });

  it('rejects tools outside the explicitly available set', () => {
    expect(() => validateProjectProfile(profile({
      criticalChecks: [{ id: 'deploy', command: 'deploy production', tool: 'made-up-cli', readOnly: true }],
    }))).toThrow("unavailable tool 'made-up-cli'");
    expect(() => validateProjectProfile(profile(), { availableTools: ['npm'] }))
      .toThrow("unavailable tool 'vitest'");
  });

  it('loads the .vscode profile before the repository-root profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'story-to-test-profile-'));
    try {
      await mkdir(join(root, '.vscode'));
      await writeFile(join(root, 'story-to-test.profile.md'), markdown(profile({ project: { name: 'root', description: 'root' } })));
      await writeFile(join(root, '.vscode', 'story-to-test.profile.md'), markdown(profile({ project: { name: 'vscode', description: 'vscode' } })));
      const result = await loadProjectProfileDocument(root);
      expect(result.profile.project.name).toBe('vscode');
      expect(result.path).toBe(join(root, '.vscode', 'story-to-test.profile.md'));
      expect(parseProjectProfileMarkdown(markdown(profile())).project.name).toBe('Eligibility');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not invent a profile when no document exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'story-to-test-profile-missing-'));
    try {
      await expect(loadProjectProfileDocument(root)).rejects.toBeInstanceOf(ProjectProfileNotFoundError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

