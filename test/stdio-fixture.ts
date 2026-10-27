import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { BukHttpClient } from '../src/client.js';
import { createBukMcpServer } from '../src/server.js';
import { createBukService } from '../src/service.js';

const secret = 'stdio-fixture-secret';
const client = new BukHttpClient({
  authToken: secret,
  fetcher: async () => new Response(JSON.stringify({
    data: [{ id: 81, full_name: 'Synthetic Stdio Employee' }],
    pagination: { count: 1, total_pages: 1, next: null },
  }), { status: 200, headers: { 'content-type': 'application/json' } }),
});
const server = createBukMcpServer(createBukService({ client }));
await server.connect(new StdioServerTransport());
