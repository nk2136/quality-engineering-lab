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

export const UiStructureEvidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['table', 'row', 'cell', 'list', 'list-item', 'frame', 'shadow-root', 'element']),
  parentId: z.string().min(1).nullable(),
  locator: z.string().min(1),
  role: z.string().min(1).nullable(),
  name: z.string().min(1).nullable(),
  childCount: z.number().int().nonnegative(),
});

export const UiStructureSnapshotSchema = z.object({
  evidence: z.array(UiStructureEvidenceSchema),
  blockers: z.array(z.string()),
});

export const UiDiscoveryResultSchema = z.object({
  locators: z.array(UiLocatorEvidenceSchema),
  observations: z.array(UiObservationSchema),
  blockers: z.array(z.string()),
  structures: z.array(UiStructureEvidenceSchema),
  structuralBlockers: z.array(z.string()),
  performedActions: z.array(ActionSchema),
});

export type UiDiscoveryRequest = z.infer<typeof UiDiscoveryRequestSchema>;
export type UiLocatorEvidence = z.infer<typeof UiLocatorEvidenceSchema>;
export type UiObservation = z.infer<typeof UiObservationSchema>;
export type UiStructureEvidence = z.infer<typeof UiStructureEvidenceSchema>;
export type UiStructureSnapshot = z.infer<typeof UiStructureSnapshotSchema>;
export type UiDiscoveryResult = z.infer<typeof UiDiscoveryResultSchema>;

export interface UiBrowserSession {
  open(url: string): Promise<void>;
  fill(locator: string, value: string): Promise<void>;
  submit(locator: string): Promise<void>;
  accessibilitySnapshot(): Promise<string>;
  locatorCount(locator: string): Promise<number>;
  screenshot(name: string): Promise<string>;
  inspectStructure(): Promise<UiStructureSnapshot>;
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

const candidates = [
  ['getByRole(button, { name: "Check eligibility" })', 'role-name'],
  ['getByLabel("Member ID")', 'label'],
  ['getByTestId("eligibility-submit")', 'test-id'],
  ['button:has-text("Check eligibility")', 'semantic'],
  ['button[type="submit"]', 'css'],
] as const;

function requireAction(actions: readonly string[], action: z.infer<typeof ActionSchema>): void {
  if (!actions.includes(action)) throw new Error(`Action '${action}' is required but not authorized.`);
}

async function observe(session: UiBrowserSession, state: UiObservation['state']): Promise<UiObservation> {
  const [snapshotRef, screenshotRef] = await Promise.all([
    session.accessibilitySnapshot(),
    session.screenshot(`eligibility-${state}`),
  ]);
  return { state, snapshotRef, screenshotRef };
}

export class UiDiscoveryAgent {
  constructor(private readonly createSession: () => UiBrowserSession) {}

  async discover(value: unknown): Promise<UiDiscoveryResult> {
    const request = validateRequest(value);
    requireAction(request.allowedActions, 'navigate');
    const session = this.createSession();
    const performedActions: z.infer<typeof ActionSchema>[] = [];
    try {
      await session.open(new URL(request.startPath, request.baseUrl).href);
      performedActions.push('navigate');

      const locators: UiLocatorEvidence[] = [];
      for (const [locator, strategy] of candidates) {
        if (await session.locatorCount(locator) === 1) {
          locators.push({ locator, strategy, count: 1 });
        }
      }
      const structure = UiStructureSnapshotSchema.parse(await session.inspectStructure());

      const observations = [await observe(session, 'initial'), await observe(session, 'empty')];
      const submitLocator = 'getByRole(button, { name: "Check eligibility" })';
      requireAction(request.allowedActions, 'submit');
      await session.submit(submitLocator);
      performedActions.push('submit');
      observations.push(await observe(session, 'validation'));

      requireAction(request.allowedActions, 'fill');
      await session.fill('getByLabel("Member ID")', 'MEMBER-42');
      performedActions.push('fill');
      await session.submit(submitLocator);
      performedActions.push('submit');
      observations.push(await observe(session, 'success'));

      return {
        locators,
        observations,
        blockers: locators.length === 0 ? ['No unique locator for Check eligibility.'] : [],
        structures: structure.evidence,
        structuralBlockers: structure.blockers,
        performedActions,
      };
    } finally {
      await session.close();
    }
  }
}
