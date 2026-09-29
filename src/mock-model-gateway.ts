import type { ContextPack } from './context.js';
import type { ModelCapability, ModelGateway, ModelRequest, ModelResponse } from './contracts.js';

export interface MockModelResponse {
  readonly task: ModelRequest['task'];
  readonly output: unknown;
  readonly finishReason?: ModelResponse['finishReason'];
}

export class MockModelGateway implements ModelGateway {
  constructor(private readonly responses: readonly MockModelResponse[]) {}

  async capabilities(): Promise<readonly ModelCapability[]> {
    return [...new Set(this.responses.map(({ task }) => task))].map((task) => ({
      provider: 'mock', model: 'deterministic', tasks: [task], supportsStructuredOutput: true,
      supportsTools: false, contextWindowTokens: 1_024, dataRegion: null,
    }));
  }

  async generate(request: ModelRequest, _context: ContextPack): Promise<ModelResponse> {
    const response = this.responses.find(({ task }) => task === request.task);
    if (!response) throw new Error(`Mock model has no response for '${request.task}'.`);
    return { provider: 'mock', model: 'deterministic', output: response.output,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, finishReason: response.finishReason ?? 'completed' };
  }
}
