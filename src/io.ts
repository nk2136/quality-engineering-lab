import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const atomicWriteQueues = new Map<string, Promise<void>>();

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const destination = resolve(path);
  const queueKey = process.platform === 'win32' ? destination.toLowerCase() : destination;
  const previous = atomicWriteQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => writeJsonAtomicNow(destination, value));
  atomicWriteQueues.set(queueKey, current);

  const removeSettledQueue = (): void => {
    if (atomicWriteQueues.get(queueKey) === current) atomicWriteQueues.delete(queueKey);
  };
  void current.then(removeSettledQueue, removeSettledQueue);
  return current;
}

async function writeJsonAtomicNow(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
