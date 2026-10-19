/**
 * Remote MCP servers (M14), opt-in: the user adds a server by https URL; its tools are listed and all start switched
 * off; the user switches tools on one by one, and every call is confirmed by the caller (McpScreen) first. This is the
 * only network use besides downloads and live lookups, and it happens only for servers the user added. Nothing from
 * the phone is sent except the arguments the user confirms.
 *
 * Transport: MCP "Streamable HTTP" (JSON-RPC 2.0 over POST; the reply is JSON or a short SSE stream).
 * ponytail: no auth headers / OAuth, no server-initiated requests, no stdio servers (not possible on Android).
 */
import { db } from './chatStore';

export type McpTool = { name: string; description: string; inputSchema: unknown; enabled: boolean };
export type McpServer = { url: string; name: string; tools: McpTool[] };

const KEY = 'mcp_servers';

/**
 * Suggested public servers: remote, no sign-in, and each checked to answer the MCP handshake (2026-10-19). Adding one
 * still lists its tools switched off. ponytail: a fixed list; a server that goes away just fails to add with a message.
 */
export const PRESETS: { name: string; url: string; about: string }[] = [
  { name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', about: 'Ask about any public GitHub repository' },
  { name: 'Context7', url: 'https://mcp.context7.com/mcp', about: 'Current docs and code examples for libraries' },
  { name: 'Hugging Face', url: 'https://huggingface.co/mcp', about: 'Search models, datasets and papers' },
  { name: 'Cloudflare docs', url: 'https://docs.mcp.cloudflare.com/mcp', about: 'Search Cloudflare documentation' },
  { name: 'GitMCP docs', url: 'https://gitmcp.io/docs', about: 'Documentation of any GitHub project' },
];
const TIMEOUT_MS = 20_000;
const MAX_RESULT_CHARS = 8000;

/** Only https servers (a local-network http server could be anything); throws with a plain message otherwise. */
export function checkUrl(url: string): string {
  const u = url.trim();
  if (!/^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/i.test(u)) throw new Error('Enter an https:// address of an MCP server.');
  return u;
}

/** Pull the JSON-RPC reply out of a JSON body or an SSE stream ("data: {...}" lines). */
export function parseReply(body: string, id: number): any {
  const candidates = body.trim().startsWith('{') ? [body] : body.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5));
  for (const c of candidates) {
    try { const m = JSON.parse(c); if (m.id === id) return m; } catch {}
  }
  throw new Error('The server sent a reply this app could not read.');
}

class Session {
  private nextId = 1;
  private sessionId: string | null = null;
  constructor(private url: string) {}

  async request(method: string, params: object = {}, notify = false): Promise<any> {
    const id = this.nextId++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(this.url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18', ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}) },
        body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
      });
      this.sessionId = res.headers.get('Mcp-Session-Id') ?? this.sessionId;
      if (notify) return null;
      if (!res.ok) throw new Error(`The server answered HTTP ${res.status}.`);
      const reply = parseReply(await res.text(), id);
      if (reply.error) throw new Error(`The server refused: ${String(reply.error.message ?? 'error').slice(0, 200)}`);
      return reply.result;
    } catch (e: any) {
      throw e?.name === 'AbortError' ? new Error('The server did not answer in time.') : e;
    } finally {
      clearTimeout(timer);
    }
  }

  async open(): Promise<{ name: string }> {
    const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Local AI', version: '1.0' } });
    await this.request('notifications/initialized', {}, true);
    return { name: String(r?.serverInfo?.name ?? new URL(this.url).host) };
  }
}

export async function listServers(): Promise<McpServer[]> {
  const row = (await db().query('SELECT value FROM meta WHERE key = ?', [KEY]))[0];
  try { return row ? JSON.parse(row.value as string) : []; } catch { return []; }
}
async function save(servers: McpServer[]) {
  await db().execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [KEY, JSON.stringify(servers)]);
}

/** Connect to a new server and store it with its tools, all switched off. */
export async function addServer(rawUrl: string): Promise<McpServer> {
  const url = checkUrl(rawUrl);
  const s = new Session(url);
  const { name } = await s.open();
  const r = await s.request('tools/list');
  const tools: McpTool[] = (r?.tools ?? []).slice(0, 100).map((t: any) => ({
    name: String(t.name), description: String(t.description ?? '').slice(0, 300), inputSchema: t.inputSchema ?? {}, enabled: false,
  }));
  const server = { url, name: name.slice(0, 80), tools };
  await save([...(await listServers()).filter(x => x.url !== url), server]);
  return server;
}

export async function removeServer(url: string): Promise<void> {
  await save((await listServers()).filter(s => s.url !== url));
}

export async function setToolEnabled(url: string, tool: string, enabled: boolean): Promise<void> {
  await save((await listServers()).map(s => (s.url !== url ? s : { ...s, tools: s.tools.map(t => (t.name === tool ? { ...t, enabled } : t)) })));
}

/** Call a switched-on tool (the caller has confirmed this exact call). Returns its text output, bounded. */
export async function callTool(url: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const server = (await listServers()).find(s => s.url === url);
  if (!server?.tools.find(t => t.name === tool)?.enabled) throw new Error('That tool is switched off.');
  const s = new Session(url);
  await s.open();
  const r = await s.request('tools/call', { name: tool, arguments: args });
  const text = (r?.content ?? []).map((c: any) => (c.type === 'text' ? String(c.text) : `[${c.type}]`)).join('\n');
  const out = (r?.isError ? 'The tool reported an error: ' : '') + (text || '(no text output)');
  return out.length > MAX_RESULT_CHARS ? `${out.slice(0, MAX_RESULT_CHARS)}…` : out;
}
