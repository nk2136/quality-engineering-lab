import { describe, expect, it } from 'vitest';
import { MockModelGateway } from '../src/mock-model-gateway.js';

describe('MockModelGateway', () => {
  it('returns configured typed output and exposes only configured capabilities', async () => {
    const gateway = new MockModelGateway([{ task: 'generate-code', output: { diff: 'patch' } }]);
    expect(await gateway.capabilities()).toHaveLength(1);
    await expect(gateway.generate({ traceId: '3d594650-3436-4d7c-86a7-2b94788009bc', task: 'generate-code', promptVersion: 'v1', input: 'x', maxOutputTokens: 10 }, {} as never)).resolves.toMatchObject({ output: { diff: 'patch' }, finishReason: 'completed' });
  });
});
