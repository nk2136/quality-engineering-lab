import type { AddressInfo } from 'node:net';
import { createDemoServer } from '../../src/demo-app.js';

export interface DemoApp {
  readonly url: string;
  close(): Promise<void>;
}

export async function startDemoApp(): Promise<DemoApp> {
  const server = createDemoServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
