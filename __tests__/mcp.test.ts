/** M14 remote MCP client against a fake Streamable HTTP server: opt-in, tools off by default, SSE and JSON replies. */
import { sqliteDb } from '../testUtils/sqliteDb';
import * as chat from '../src/chatStore';
import * as mcp from '../src/mcp';

const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
const calls: { method: string; session: string | null; body: any }[] = [];

function fakeServer(sse: boolean) {
  return jest.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, session: init.headers['Mcp-Session-Id'] ?? null, body });
    const result = body.method === 'initialize' ? { serverInfo: { name: 'Weather MCP' }, capabilities: {} }
      : body.method === 'tools/list' ? { tools: [{ name: 'forecast', description: 'Forecast for a city', inputSchema: { type: 'object' } }] }
      : body.method === 'tools/call' ? { content: [{ type: 'text', text: `Sunny in ${body.arguments?.city ?? body.params.arguments.city}` }] } : null;
    const msg = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    return {
      ok: true, status: 200,
      headers: { get: (h: string) => (h === 'Mcp-Session-Id' ? 'sess-1' : null) },
      text: async () => (body.id === undefined ? '' : sse ? `event: message\ndata: ${msg}\n\n` : msg),
    };
  });
}

beforeEach(async () => {
  const fs = node('fs'), os = node('os'), path = node('path');
  chat.setDb(sqliteDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-')), 'chat.db')));
  await chat.open();
  calls.length = 0;
});

test('only https addresses are accepted', () => {
  for (const u of ['http://example.com/mcp', 'ftp://x.y', 'example.com', 'https://localhost/mcp', 'javascript:alert(1)']) {
    expect(() => mcp.checkUrl(u)).toThrow(/https/);
  }
  expect(mcp.checkUrl(' https://mcp.example.com/mcp ')).toBe('https://mcp.example.com/mcp');
});

test.each([false, true])('a new server\'s tools start off; a call needs the tool switched on (SSE replies: %s)', async sse => {
  (globalThis as any).fetch = fakeServer(sse);
  const s = await mcp.addServer('https://weather.example.com/mcp');
  expect(s).toMatchObject({ name: 'Weather MCP', tools: [{ name: 'forecast', enabled: false }] });
  await expect(mcp.callTool(s.url, 'forecast', { city: 'Pune' })).rejects.toThrow(/switched off/);
  expect(calls.some(c => c.method === 'tools/call')).toBe(false); // refused before anything was sent
  await mcp.setToolEnabled(s.url, 'forecast', true);
  expect(await mcp.callTool(s.url, 'forecast', { city: 'Pune' })).toBe('Sunny in Pune');
  const call = calls.find(c => c.method === 'tools/call')!;
  expect(call.session).toBe('sess-1'); // the session from initialize is carried
  expect(call.body.params).toEqual({ name: 'forecast', arguments: { city: 'Pune' } }); // exactly the confirmed arguments
  await mcp.removeServer(s.url);
  expect(await mcp.listServers()).toEqual([]);
});
