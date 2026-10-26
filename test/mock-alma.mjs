import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

// Minimal RFC 6455 server, so tests exercise Node's real fetch/WebSocket without npm dependencies.
function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, payload]);
}
export async function mockAlma() {
  const threads = new Map();
  const clients = new Set();
  const requests = [];
  const writes = [];
  let count = 0;
  const mock = { threads, requests, writes, clients, mode: 'complete', snapshot: true, onGenerate: null, onStop: null, onHistory: null, onCreate: null };
  const broadcast = (type, data) => {
    for (const socket of clients) if (!socket.destroyed) socket.write(frame({ type, data }));
  };
  mock.broadcast = broadcast;
  mock.finish = (id, answer = '本轮回答') => {
    const thread = threads.get(id);
    thread.messages.push({ id: `storage-${++count}`, message: { id: `assistant-${count}`, role: 'assistant', parts: [{ type: 'text', text: answer }] } });
    thread.busy = false;
    broadcast('generation_completed', { threadId: id });
    broadcast('thread_generating', { id, isGenerating: false });
  };
  mock.seed = (id = `thread-${++count}`) => {
    threads.set(id, { messages: [], busy: false });
    return id;
  };
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/threads') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const id = mock.seed();
      mock.onCreate?.(JSON.parse(body), id);
      if (mock.mode === 'create-disconnect') return req.socket.destroy();
      res.writeHead(201); res.end(JSON.stringify({ id })); return;
    }
    const match = req.url.match(/^\/api\/threads\/([a-zA-Z0-9_-]+)\/messages$/);
    if (req.method === 'GET' && match && threads.has(match[1])) {
      mock.onHistory?.(match[1]);
      if (mock.mode === 'history-fail') { res.writeHead(503); res.end('{}'); return; }
      res.end(JSON.stringify(threads.get(match[1]).messages)); return;
    }
    res.writeHead(404); res.end('{}');
  });
  server.on('upgrade', (req, socket) => {
    if (req.url !== '/ws/threads') return socket.destroy();
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    if (mock.snapshot) socket.write(frame({ type: 'generating_snapshot', data: { ids: [...threads].filter(([, t]) => t.busy).map(([id]) => id) } }));
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15;
        const masked = !!(buffered[1] & 128);
        let size = buffered[1] & 127, offset = 2;
        if (size === 126) { if (buffered.length < 4) return; size = buffered.readUInt16BE(2); offset = 4; }
        if (size === 127) { if (buffered.length < 10) return; size = Number(buffered.readBigUInt64BE(2)); offset = 10; }
        if (buffered.length < offset + (masked ? 4 : 0) + size) return;
        const mask = masked ? buffered.subarray(offset, offset + 4) : null;
        offset += masked ? 4 : 0;
        const payload = Buffer.from(buffered.subarray(offset, offset + size));
        buffered = buffered.subarray(offset + size);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString());
        writes.push(message);
        const { threadId: id } = message.data;
        const thread = threads.get(id);
        if (message.type === 'generate_response') {
          // Alma ignores client-supplied message IDs and creates its own.
          thread.messages.push({ id: `storage-${++count}`, message: { ...message.data.userMessage, id: `user-${count}` } });
          thread.busy = true;
          broadcast('thread_generating', { id, isGenerating: true });
          mock.onGenerate?.(message);
          if (mock.mode === 'complete') mock.finish(id);
          if (mock.mode === 'disconnect') socket.destroy();
        }
        if (message.type === 'stop_generation') {
          if (mock.onStop) { mock.onStop(message); continue; }
          thread.busy = false;
          broadcast('thread_generating', { id, isGenerating: false });
          broadcast('generation_stopped', { threadId: id });
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  mock.baseURL = `http://127.0.0.1:${server.address().port}`;
  mock.close = async () => {
    for (const socket of clients) socket.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  return mock;
}

export function host(initial = {}) {
  let state = structuredClone(initial);
  const saved = [], execs = [];
  let seq = 0;
  return {
    saved, execs,
    get state() { return structuredClone(state); },
    context(requestID = `request-${++seq}`, signal = new AbortController().signal) {
      return {
        requestID, signal, configuration: {}, state: structuredClone(state),
        async saveState(value) { state = structuredClone(value); this.state = structuredClone(value); saved.push(structuredClone(value)); },
        async exec(...args) { execs.push(args); return { exitCode: 0, stdout: '', stderr: '' }; },
      };
    },
  };
}
