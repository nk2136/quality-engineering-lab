import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readJson, writeJsonAtomic } from '../src/io.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('atomic JSON checkpoints', () => {
  it('creates parent directories and writes formatted JSON readable by readJson', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qe-io-'));
    directories.push(directory);
    const path = join(directory, 'nested', 'checkpoint.json');
    const checkpoint = { version: 1, status: 'pending' };

    await writeJsonAtomic(path, checkpoint);

    expect(await readFile(path, 'utf8')).toBe('{\n  "version": 1,\n  "status": "pending"\n}\n');
    expect(await readJson(path)).toEqual(checkpoint);
  });

  it('replaces an existing checkpoint without leaving a temporary file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qe-io-'));
    directories.push(directory);
    const path = join(directory, 'checkpoint.json');

    await writeJsonAtomic(path, { version: 1 });
    await writeJsonAtomic(path, { version: 2 });

    expect(await readJson(path)).toEqual({ version: 2 });
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
