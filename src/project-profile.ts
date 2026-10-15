import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const GitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

const ArchitectureEntrySchema = z.object({
  componentId: z.string().trim().min(1),
  responsibility: z.string().trim().min(1),
  dependsOn: z.array(z.string().trim().min(1)),
}).strict();

const ComponentSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  responsibilities: z.array(z.string().trim().min(1)).min(1),
  repositoryIds: z.array(z.string().trim().min(1)).min(1),
}).strict();

const RepositorySchema = z.object({
  id: z.string().trim().min(1),
  provider: z.literal('github'),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  revision: GitObjectIdSchema,
  paths: z.array(z.string().trim().min(1)).min(1).max(50),
  accessMode: z.literal('read-only'),
}).strict();

const CommandSchema = z.object({
  id: z.string().trim().min(1),
  command: z.string().trim().min(1),
  tool: z.string().trim().min(1),
  readOnly: z.literal(true),
}).strict();

export const ProjectProfileSchema = z.object({
  schemaVersion: z.literal('1.0'),
  project: z.object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
  }).strict(),
  architectureMap: z.array(ArchitectureEntrySchema).min(1),
  ticketSystem: z.object({
    provider: z.literal('jira'),
    baseUrl: z.string().url(),
    issueKeyPattern: z.string().trim().min(1),
    accessMode: z.literal('read-only'),
  }).strict(),
  components: z.array(ComponentSchema).min(1),
  repositories: z.array(RepositorySchema).min(1),
  frameworkConventions: z.object({
    language: z.literal('typescript'),
    testRunner: z.enum(['vitest', 'playwright']),
    testFilePatterns: z.array(z.string().trim().min(1)).min(1),
    sourceDirectory: z.string().trim().min(1),
    testDirectory: z.string().trim().min(1),
    commands: z.array(CommandSchema).min(1),
  }).strict(),
  dataRules: z.object({
    syntheticDataOnly: z.literal(true),
    secretsAllowed: z.literal(false),
    forbiddenData: z.array(z.string().trim().min(1)).min(1),
    allowedDataSources: z.array(z.enum(['fixtures', 'mocks', 'local-artifacts'])).min(1),
  }).strict(),
  reportingExport: z.object({
    formats: z.array(z.enum(['json', 'markdown', 'junit', 'html'])).min(1),
    destinations: z.array(z.enum(['local-file', 'artifact-store'])).min(1),
  }).strict(),
  criticalChecks: z.array(CommandSchema).min(1),
  hardRules: z.array(z.string().trim().min(1)).min(1),
}).strict().superRefine((profile, context) => {
  const componentIds = uniqueIds(profile.components.map((component) => component.id), 'component', context);
  const repositoryIds = uniqueIds(profile.repositories.map((repository) => repository.id), 'repository', context);
  uniqueIds(profile.frameworkConventions.commands.map((command) => command.id), 'framework command', context);
  uniqueIds(profile.criticalChecks.map((check) => check.id), 'critical check', context);

  for (const entry of profile.architectureMap) {
    if (!componentIds.has(entry.componentId)) {
      context.addIssue({ code: 'custom', path: ['architectureMap'], message: `Architecture map references unknown component '${entry.componentId}'.` });
    }
    for (const dependency of entry.dependsOn) {
      if (!componentIds.has(dependency)) {
        context.addIssue({ code: 'custom', path: ['architectureMap'], message: `Architecture map dependency '${dependency}' is not a declared component.` });
      }
    }
  }

  for (const component of profile.components) {
    for (const repositoryId of component.repositoryIds) {
      if (!repositoryIds.has(repositoryId)) {
        context.addIssue({ code: 'custom', path: ['components'], message: `Component '${component.id}' references unknown repository '${repositoryId}'.` });
      }
    }
  }

  const baseUrl = new URL(profile.ticketSystem.baseUrl);
  if (baseUrl.protocol !== 'https:') {
    context.addIssue({ code: 'custom', path: ['ticketSystem', 'baseUrl'], message: 'Ticket system baseUrl must use HTTPS.' });
  }
  if (baseUrl.username !== '' || baseUrl.password !== '') {
    context.addIssue({ code: 'custom', path: ['ticketSystem', 'baseUrl'], message: 'Ticket system baseUrl must not contain credentials.' });
  }
});

function uniqueIds(ids: readonly string[], label: string, context: z.RefinementCtx): Set<string> {
  const result = new Set<string>();
  for (const id of ids) {
    if (result.has(id)) {
      context.addIssue({ code: 'custom', message: `${label} IDs must be unique; '${id}' is duplicated.` });
    }
    result.add(id);
  }
  return result;
}

export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

export interface ProjectProfileValidationOptions {
  readonly availableTools?: readonly string[];
}

const defaultAvailableTools = new Set(['node', 'npm', 'npx', 'typescript', 'vitest', 'playwright']);

function toolsUsed(profile: ProjectProfile): string[] {
  return [
    profile.frameworkConventions.testRunner,
    ...profile.frameworkConventions.commands.map((command) => command.tool),
    ...profile.criticalChecks.map((check) => check.tool),
  ];
}

/** Validates the profile and ensures every declared command uses an available local tool. */
export function validateProjectProfile(
  value: unknown,
  options: ProjectProfileValidationOptions = {},
): ProjectProfile {
  const profile = ProjectProfileSchema.parse(value);
  const available = options.availableTools === undefined
    ? defaultAvailableTools
    : new Set(options.availableTools);
  for (const tool of toolsUsed(profile)) {
    if (!available.has(tool)) throw new Error(`Project profile references unavailable tool '${tool}'.`);
  }
  return profile;
}

export class ProjectProfileNotFoundError extends Error {
  constructor(rootOrPath: string) {
    super(`No story-to-test.profile.md found at '${rootOrPath}' or its .vscode directory.`);
    this.name = 'ProjectProfileNotFoundError';
  }
}

export interface LoadedProjectProfile {
  readonly profile: ProjectProfile;
  readonly path: string;
}

function profileJson(markdown: string): unknown {
  const match = markdown.match(/```json\s*([\s\S]*?)```/i);
  if (match?.[1] === undefined) {
    throw new Error('Project profile must contain one ```json fenced object.');
  }
  try {
    return JSON.parse(match[1]) as unknown;
  } catch (error) {
    throw new Error('Project profile JSON is invalid.', { cause: error });
  }
}

/** Parses one Markdown profile without discovering values from the repository. */
export function parseProjectProfileMarkdown(
  markdown: string,
  options: ProjectProfileValidationOptions = {},
): ProjectProfile {
  return validateProjectProfile(profileJson(markdown), options);
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function resolveProfilePath(rootOrPath: string): Promise<string> {
  const resolved = resolve(rootOrPath);
  if (resolved.toLowerCase().endsWith('story-to-test.profile.md')) {
    if (await readable(resolved)) return resolved;
    throw new ProjectProfileNotFoundError(rootOrPath);
  }
  for (const candidate of [join(resolved, '.vscode', 'story-to-test.profile.md'), join(resolved, 'story-to-test.profile.md')]) {
    if (await readable(candidate)) return candidate;
  }
  throw new ProjectProfileNotFoundError(rootOrPath);
}

/** Loads `.vscode/story-to-test.profile.md` first, then the repository-root profile. */
export async function loadProjectProfileDocument(
  rootOrPath: string,
  options: ProjectProfileValidationOptions = {},
): Promise<LoadedProjectProfile> {
  const path = await resolveProfilePath(rootOrPath);
  const markdown = await readFile(path, 'utf8');
  return { profile: parseProjectProfileMarkdown(markdown, options), path };
}

export async function loadProjectProfile(
  rootOrPath: string,
  options: ProjectProfileValidationOptions = {},
): Promise<ProjectProfile> {
  return (await loadProjectProfileDocument(rootOrPath, options)).profile;
}

