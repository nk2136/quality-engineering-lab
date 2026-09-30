import type { KnowledgeSource } from './contracts.js';
import {
  GitHubRepositoryKnowledgeSource,
  type GitHubHttpClient,
} from './github-repository.js';
import {
  JiraCloudKnowledgeSource,
  type JiraHttpClient,
} from './jira-cloud.js';
import { CompositeKnowledgeSource } from './knowledge-assembler.js';

export interface LiveReadinessAdapterPolicy {
  jira: {
    baseUrl: string;
    allowedIssueKeys: readonly string[];
  };
  github: {
    repository: string;
    revision: string;
    paths: readonly string[];
  };
}

export interface LiveReadinessCredentialProviders {
  jira?: () => Promise<string | undefined>;
  github?: () => Promise<string | undefined>;
}

export interface LiveReadinessAdapterDependencies {
  credentials?: LiveReadinessCredentialProviders;
  jiraHttpClient?: JiraHttpClient;
  githubHttpClient?: GitHubHttpClient;
  timeoutMs?: number;
}

export function createLiveReadinessKnowledgeSource(
  policy: LiveReadinessAdapterPolicy,
  dependencies: LiveReadinessAdapterDependencies = {},
): KnowledgeSource {
  return new CompositeKnowledgeSource({
    jira: new JiraCloudKnowledgeSource({
      baseUrl: policy.jira.baseUrl,
      allowedIssueKeys: policy.jira.allowedIssueKeys,
      ...(dependencies.credentials?.jira === undefined
        ? {} : { authorization: dependencies.credentials.jira }),
      ...(dependencies.jiraHttpClient === undefined
        ? {} : { httpClient: dependencies.jiraHttpClient }),
      ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs }),
    }),
    github: new GitHubRepositoryKnowledgeSource({
      repository: policy.github.repository,
      revision: policy.github.revision,
      paths: policy.github.paths,
      ...(dependencies.credentials?.github === undefined
        ? {} : { authorization: dependencies.credentials.github }),
      ...(dependencies.githubHttpClient === undefined
        ? {} : { httpClient: dependencies.githubHttpClient }),
      ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs }),
    }),
  });
}
