import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createEditorServer } from './editor-mcp.js';

const flag = process.argv.indexOf('--root');
const root = resolve(flag === -1 ? '.qa-workflows' : process.argv[flag + 1] ?? '.qa-workflows');
const server = createEditorServer(root);
await server.connect(new StdioServerTransport());
