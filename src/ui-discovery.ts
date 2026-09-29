import { z } from 'zod';

const ActionSchema = z.enum(['navigate', 'fill', 'submit']);

export const UiDiscoveryRequestSchema = z.object({
  traceId: z.string().uuid(),
  requirementArtifactId: z.string().min(1),
  baseUrl: z.string().url(),
  routes: z.array(z.string().startsWith('/')).min(1),
  startPath: z.string().startsWith('/'),
  allowedActions: z.array(z.string()).min(1),
});

export const UiLocatorEvidenceSchema = z.object({
  locator: z.string().min(1),
  strategy: z.enum(['role-name', 'label', 'test-id', 'semantic', 'css']),
  count: z.literal(1),
});

export const UiObservationSchema = z.object({
  state: z.enum(['initial', 'empty', 'validation', 'success']),
  snapshotRef: z.string().min(1),
  screenshotRef: z.string().min(1),
});

export const UiDiscoveryResultSchema = z.object({
  locators: z.array(UiLocatorEvidenceSchema),
  observations: z.array(UiObservationSchema),
  blockers: z.array(z.string()),
  performedActions: z.array(ActionSchema),
});

export type UiDiscoveryRequest = z.infer<typeof UiDiscoveryRequestSchema>;
export type UiLocatorEvidence = z.infer<typeof UiLocatorEvidenceSchema>;
export type UiObservation = z.infer<typeof UiObservationSchema>;
export type UiDiscoveryResult = z.infer<typeof UiDiscoveryResultSchema>;

export interface UiBrowserSession {
  open(url: string): Promise<void>;
  fill(locator: string, value: string): Promise<void>;
  submit(locator: string): Promise<void>;
  accessibilitySnapshot(): Promise<string>;
  locatorCount(locator: string): Promise<number>;
  screenshot(name: string): Promise<string>;
  close(): Promise<void>;
}

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

function validateRequest(value: unknown): UiDiscoveryRequest {
  const request = UiDiscoveryRequestSchema.parse(value);
  const baseUrl = new URL(request.baseUrl);
  if (!isLoopback(baseUrl)) throw new Error('UI discovery requires a loopback http base URL.');
  if (!request.routes.includes(request.startPath)) {
    throw new Error(`Start path '${request.startPath}' is not in the authorized route allowlist.`);
  }
  for (const action of request.allowedActions) {
    if (!ActionSchema.safeParse(action).success) throw new Error(`Action '${action}' is not permitted for UI discovery.`);
  }
  return request;
}

export class UiDiscoveryAgent {
  constructor(private readonly createSession: () => UiBrowserSession) {}

  async discover(value: unknown): Promise<UiDiscoveryResult> {
    validateRequest(value);
    return { locators: [], observations: [], blockers: [], performedActions: [] };
  }
}
