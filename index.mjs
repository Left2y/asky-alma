import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');

const HELP = `Alma · 本机持久会话
直接输入问题：续聊；首次自动创建会话。
/new：新建空会话；/new 问题：新建后提问。
/status：状态；/reply：本轮回复；/history：最近 20 条文字消息。
/threads：仅列出本插件保存的会话；/use ID：切换其中一个。
/stop：停止当前会话生成；/open：在 Alma 中打开。
/help：帮助。要发送以 / 开头的原文，请用 /ask 原文。
回车才执行。单次最多 4 分钟，约 220 秒停止等待并保留收尾时间。
超时或断开后 Alma 可继续运行；用 /reply 或 /status 续查，勿重发。
工具审批可能需要到 Alma 窗口处理。`;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const READS = new Set(['help', 'status', 'reply', 'history', 'threads']);
const MAX_TEXT = 48 * 1024;

class FriendlyError extends Error {}
function text(value) {
  const bytes = Buffer.from(String(value));
  return { text: bytes.length <= MAX_TEXT ? String(value) : `${bytes.subarray(0, MAX_TEXT).toString('utf8')}\n…显示已截断，请在 Alma 查看全文。` };
}
function parse(input = '') {
  const value = input.trim();
  if (!value) return { action: 'help', value: '' };
  if (!value.startsWith('/')) return { action: 'ask', value };
  const [, action, rest = ''] = value.match(/^\/(\S+)(?:\s+([\s\S]*))?$/) ?? [];
  if (!action || !new Set([...READS, 'new', 'use', 'stop', 'open', 'ask']).has(action)) {
    throw new FriendlyError('未知命令。用 /help 查看帮助；发送以 / 开头的原文请用 /ask 原文。');
  }
  if (!['new', 'ask', 'use'].includes(action) && rest) throw new FriendlyError(`/${action} 不接受参数。`);
  if (['ask', 'use'].includes(action) && !rest.trim()) throw new FriendlyError(`/${action} 需要参数。`);
  return { action, value: rest.trim() };
}
function load(context) {
  const raw = context.state ?? {};
  if (Object.keys(raw).length && raw.version !== 1) throw new FriendlyError('插件状态版本不兼容，已停止操作。请保留 Asky 状态并检查插件版本。');
  const state = structuredClone({ version: 1, sessions: [], operations: [], seen: [], ...raw });
  if (!Array.isArray(state.sessions) || !Array.isArray(state.operations) || !Array.isArray(state.seen) || state.sessions.some(s => typeof s?.id !== 'string' || !ID.test(s.id))) {
    throw new FriendlyError('插件会话记录无效，已停止操作。');
  }
  return state;
}
function selected(state) {
  const session = state.sessions.find(s => s.id === state.current);
  if (!session) throw new FriendlyError('尚未选择会话。输入问题会自动创建，或用 /new 新建。');
  return session;
}
function messages(body) {
  const rows = Array.isArray(body) ? body : body?.messages;
  if (!Array.isArray(rows)) throw new FriendlyError('Alma 消息协议已变化，无法核实历史；没有重发。');
  return rows.map(row => {
    let message = row.message ?? row;
    if (typeof message === 'string') {
      try { message = JSON.parse(message); } catch { throw new FriendlyError('Alma 返回了无法解析的消息。'); }
    }
    return {
      ids: [row.id, message.id].filter(v => typeof v === 'string'),
      role: message.role,
      text: (message.parts ?? []).filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n'),
    };
  });
}
function turnInfo(rows, session) {
  const turn = session.turn;
  let start = -1;
  if (turn) {
    // Alma rewrites user message IDs. Match only the first new user after the durable baseline.
    const baseline = turn.afterId === null ? -1 : rows.findIndex(m => m.ids.includes(turn.afterId));
    if (turn.afterId === null || baseline >= 0) {
      const candidate = rows.findIndex((m, i) => i > baseline && m.role === 'user');
      if (candidate >= 0 && hash(rows[candidate].text) === turn.textHash) start = candidate;
    }
  } else start = rows.findLastIndex(m => m.role === 'user');
  const verified = !!turn && start >= 0;
  const following = start >= 0 ? rows.slice(start + 1) : [];
  const nextUser = following.findIndex(m => m.role === 'user');
  const turnRows = nextUser < 0 ? following : following.slice(0, nextUser);
  return { verified, reply: turnRows.filter(m => m.role === 'assistant' && m.text).map(m => m.text).join('\n\n') };
}

// Only tests inject a different loopback port or shorter deadlines; no user URL setting.
export function createPlugin({ baseURL = 'http://127.0.0.1:23001', waitMs = 220_000, ioMs = 5_000, noTools = false } = {}) {
  const endpoint = new URL(baseURL);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Only an HTTP IPv4 loopback origin is supported');
  }
  const origin = endpoint.origin;
  const wsURL = `${origin.replace('http:', 'ws:')}/ws/threads`;
  async function api(path, context, init = {}) {
    const response = await fetch(`${origin}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.any([context.signal ?? new AbortController().signal, AbortSignal.timeout(ioMs)]),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new FriendlyError(response.status === 404 ? '会话已不存在；请用 /new 创建新会话。' : `Alma 返回 HTTP ${response.status}；操作结果需续查。`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16 * 1024 * 1024) throw new FriendlyError('会话历史超过读取上限，请在 Alma 中查看，或新建会话。');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new FriendlyError('Alma 返回了无法解析的数据；请检查版本兼容性。'); }
  }
  const history = async (id, context) => messages(await api(`/api/threads/${id}/messages`, context));

  async function connect(id, context) {
    if (typeof WebSocket !== 'function' || typeof fetch !== 'function') throw new FriendlyError('需要 Asky 随包 Node 22 的 fetch/WebSocket。请更新 Asky。');
    const socket = new WebSocket(wsURL);
    let readyResolve, readyReject, change;
    let seenSnapshot = false, busy = false, closed = false, failure = '', terminal = '';
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    function notify() { change?.(); change = undefined; }
    function fail() {
      closed = true;
      if (!seenSnapshot) readyReject(new FriendlyError('无法连接 Alma 会话服务。请先打开 Alma，并检查本机接口是否可用。'));
      notify();
    }
    socket.addEventListener('error', fail);
    socket.addEventListener('close', fail);
    socket.addEventListener('message', event => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      const data = frame.data;
      if (frame.type === 'generating_snapshot' && Array.isArray(data?.ids)) {
        if (!seenSnapshot) { busy = data.ids.includes(id); seenSnapshot = true; readyResolve(); }
        return;
      }
      // Ignore every event for other threads, including errors and completion.
      if ((data?.threadId ?? (frame.type === 'thread_generating' ? data?.id : undefined)) !== id) return;
      if (frame.type === 'thread_generating') {
        busy = data.isGenerating;
        if (busy === false) terminal = terminal || 'idle';
      }
      if (frame.type === 'generation_completed') terminal = 'completed';
      if (frame.type === 'generation_stopped') { terminal = 'stopped'; busy = false; }
      if (frame.type === 'generation_error') { terminal = 'error'; failure = 'Alma 生成失败；请在 Alma 查看原因，再决定是否发送新请求。'; }
      notify();
    });
    const abort = () => { fail(); socket.close(); };
    context.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => readyReject(new FriendlyError('Alma 未提供生成状态快照。为避免误发为追加指令，本次没有发送；请检查 Alma 版本。')), ioMs);
    try {
      if (context.signal?.aborted) abort();
      await ready;
      if (closed) throw new FriendlyError('Alma 连接已断开，请稍后查询。');
    } catch (error) { socket.close(); context.signal?.removeEventListener('abort', abort); throw error; }
    finally { clearTimeout(timer); }
    return {
      get busy() { return busy; },
      get closed() { return closed; },
      get terminal() { return terminal; },
      get failure() { return failure; },
      send(frame) {
        if (closed || socket.readyState !== WebSocket.OPEN) throw new FriendlyError('连接已断开；结果未知，请用 /reply 查询，不要重发。');
        terminal = ''; failure = '';
        socket.send(JSON.stringify(frame));
      },
      async wait(ms) {
        // Completion/error can precede the idle event; stop must still yield while busy.
        if (closed || context.signal?.aborted) return;
        await new Promise(resolve => {
          const timer = setTimeout(() => { change = undefined; resolve(); }, ms);
          change = () => { clearTimeout(timer); resolve(); };
        });
      },
      close() { context.signal?.removeEventListener('abort', abort); socket.close(); },
    };
  }
  function summary(rows, session, connection) {
    const info = turnInfo(rows, session);
    const status = connection.closed ? '连接已断开，完成状态未知' : connection.failure || (connection.busy ? 'Alma 正在生成（也可能等待工具审批）' : '当前未在生成');
    return `会话 ${session.id}\n${status}。${session.turn ? (info.verified ? '\n本轮用户消息已在持久历史核实。' : '\n本轮发送结果尚未核实；不要自动重发。') : ''}${info.reply ? `\n\n${info.reply}` : '\n尚无可读取的本轮文字回复。'}\n\n用 /reply 续查，/open 在 Alma 查看。`;
  }
  async function query(what, context) {
    if (what === 'help') return text(HELP);
    const state = load(context);
    if (what === 'threads') return text(state.sessions.length ? state.sessions.map(s => `${s.id === state.current ? '当前 · ' : ''}${s.id} · ${s.createdAt}`).join('\n') : '本插件尚未保存会话。直接输入问题或 /new 开始。');
    const session = selected(state);
    const connection = await connect(session.id, context);
    try {
      const rows = await history(session.id, context);
      if (what === 'history') return text(`会话 ${session.id} · 最近 20 条文字消息\n\n${rows.filter(m => ['user', 'assistant'].includes(m.role) && m.text).slice(-20).map(m => `${m.role === 'user' ? '你' : 'Alma'}：${m.text}`).join('\n\n') || '暂无文字消息。'}`);
      if (what === 'status') {
        const info = turnInfo(rows, session);
        return text(`会话 ${session.id}\n${connection.closed ? '连接已断开，状态未知。' : connection.busy ? 'Alma 正在生成，可能等待工具审批。' : '当前未在生成。'}\n${session.turn ? info.verified ? '本轮发送已核实。' : '本轮发送尚未核实；不要自动重发。' : '尚未通过插件发送消息。'}${connection.failure ? `\n${connection.failure}` : ''}\n用 /reply 获取回复，/open 打开 Alma。`);
      }
      return text(summary(rows, session, connection));
    } finally { connection.close(); }
  }
  async function save(context, state) { await context.saveState(structuredClone(state)); }
  async function execute({ input }, context) {
    context = { ...context, signal: AbortSignal.any([context.signal ?? new AbortController().signal, AbortSignal.timeout(230_000)]) };
    let connection;
    let externalAttempted = false;
    try {
      const command = parse(input);
      if (READS.has(command.action)) return await query(command.action, context);
      if (typeof context.requestID !== 'string' || !context.requestID || context.requestID.length > 256) throw new FriendlyError('Asky 没有提供有效 requestID；为避免重复操作，本次已拒绝执行。');
      const state = load(context);
      const digest = createHash('sha256').update(input).digest('hex');
      const previous = state.operations.find(o => o.requestID === context.requestID);
      if (previous) {
        if (previous.digest !== digest) return text('请求 ID 已用于其他参数；没有执行。请在 Asky 发起新请求。');
        return await readback({ input }, context, null) ?? text('这次请求已有尝试记录，结果仍待核实。没有重发；请用 /reply 或 /threads 查询。');
      }
      if (state.seen.includes(hash(context.requestID))) return text('这次旧请求已有尝试记录，详细检查点已归档；没有重放。请用 /reply、/status 或 /threads 查询。');
      if (command.action === 'use' && !state.sessions.some(s => s.id === command.value)) throw new FriendlyError('只能选择 /threads 中本插件保存的会话 ID；没有读取其他历史。');
      if (command.action === 'ask' && state.pendingCreation) throw new FriendlyError('上一次新建会话的结果尚未核实，本次没有创建或发送。请先在 Alma 核对，再明确 /new 新建，或 /use 选择已保存的会话。');
      if (command.action === 'ask' && !command.value) throw new FriendlyError('请输入问题。');
      if (Buffer.byteLength(command.value) > 64 * 1024) throw new FriendlyError('输入超过 64 KiB，请缩短后再发。');
      const operation = { requestID: context.requestID, digest, action: command.action, phase: 'prepared' };
      if (command.action !== 'new' && (command.action !== 'ask' || state.current)) operation.threadId = selected(state).id;
      if (state.seen.length >= 2048) throw new FriendlyError('插件已保留 2048 个写请求防重放记录。查询仍可用；请保留 Asky 状态并联系维护者迁移。');
      state.seen.push(hash(context.requestID));
      state.operations.push(operation);
      state.operations = state.operations.slice(-64);
      // Durable intent must precede every externally visible write. A missing reply is never permission to replay.
      await save(context, state);
      if (command.action === 'use') {
        state.current = command.value;
        delete state.pendingCreation;
        operation.threadId = command.value; operation.phase = 'selected';
        await save(context, state);
        return text(`已选择插件会话 ${command.value}。下一条问题将在此续聊。`);
      }
      let session;
      if (command.action === 'new' || !state.current) {
        if (state.sessions.length >= 100) throw new FriendlyError('插件已保存 100 个会话；请用 /threads 和 /use 复用已有会话。');
        operation.phase = 'creating';
        state.pendingCreation = context.requestID;
        await save(context, state);
        externalAttempted = true;
        const created = await api('/api/threads', context, { method: 'POST', body: JSON.stringify({ title: 'Asky · Alma' }) });
        if (typeof created?.id !== 'string' || !ID.test(created.id)) throw new FriendlyError('Alma 创建会话的返回格式已变化；结果未知，没有重新创建。');
        session = { id: created.id, createdAt: new Date().toISOString() };
        state.sessions.push(session); state.current = session.id;
        delete state.pendingCreation;
        operation.threadId = session.id; operation.phase = 'created';
        await save(context, state);
        if (!command.value) return text(`已新建并选择会话 ${session.id}。直接输入问题开始。`);
      } else session = selected(state);
      if (command.action === 'open') {
        operation.phase = 'opening';
        await save(context, state);
        externalAttempted = true;
        const result = await context.exec('/usr/bin/open', [`alma://thread/${session.id}`], { timeoutSeconds: 10 });
        operation.phase = result.exitCode === 0 ? 'opened' : 'open-failed';
        await save(context, state);
        return text(result.exitCode === 0 ? '已向 macOS 提交打开请求；请在 Alma 窗口确认。' : 'macOS 未能打开 Alma。请手动打开应用。');
      }
      connection = await connect(session.id, context);
      if (command.action === 'stop') {
        if (!connection.busy) { operation.phase = 'already-idle'; await save(context, state); return text('当前会话未在生成，无需停止。'); }
        operation.phase = 'stopping'; await save(context, state);
        externalAttempted = true;
        connection.send({ type: 'stop_generation', data: { threadId: session.id } });
        const end = Date.now() + ioMs;
        while (connection.busy && !connection.closed && Date.now() < end) await connection.wait(Math.max(1, end - Date.now()));
        return text(connection.busy || connection.closed ? '已尝试发送停止请求，尚未核实。用 /status 查询；不会重发。' : '当前会话已停止生成。');
      }
      // A fresh snapshot plus live events protects against accidentally steering an existing generation.
      if (connection.busy) { operation.phase = 'blocked-busy'; await save(context, state); return text('当前会话正在生成，未发送这条问题。请用 /reply 查询、/stop 停止，或 /new 新建会话。'); }
      const rows = await history(session.id, context);
      if (session.turn && !turnInfo(rows, session).verified) {
        operation.phase = 'blocked-unknown'; await save(context, state);
        return text('上一轮发送结果尚未核实，本次没有发送。用 /reply 续查，或在 Alma 核对后用 /new 开始独立会话。');
      }
      if (connection.busy || connection.closed) throw new FriendlyError('会话状态已变化，本次未发送。用 /status 查询。');
      if (rows.length && !rows.at(-1).ids.length) throw new FriendlyError('Alma 历史缺少消息 ID，本次未发送；请检查协议兼容性。');
      const previousTurn = session.turn;
      session.turn = { requestID: context.requestID, afterId: rows.at(-1)?.ids[0] ?? null, textHash: hash(command.value) };
      operation.turn = session.turn; operation.phase = 'sending';
      await save(context, state);
      // Recheck after the state RPC: never turn a newly busy thread into steering.
      if (connection.busy || connection.closed) {
        if (previousTurn) session.turn = previousTurn;
        else delete session.turn;
        operation.phase = 'blocked-busy'; await save(context, state);
        return text('会话状态已变化，本次未发送；请先 /status 查询。');
      }
      externalAttempted = true;
      connection.send({ type: 'generate_response', data: {
        threadId: session.id, tools: ['__auto__'], ...(noTools ? { noTools: true } : {}),
        userMessage: { role: 'user', parts: [{ type: 'text', text: command.value }] },
      } });
      operation.phase = 'sent'; await save(context, state);
      const deadline = Date.now() + waitMs;
      while (!connection.terminal && !connection.closed && !context.signal?.aborted && Date.now() < deadline) {
        await connection.wait(Math.max(1, deadline - Date.now()));
      }
      const persisted = await history(session.id, context);
      return text(`${summary(persisted, session, connection)}${!connection.terminal ? '\n\n本次等待已结束，Alma 未被自动停止；后续只需查询。' : ''}`);
    } catch (error) {
      // Errors before external I/O are known no-ops; let the launcher display their helpful text.
      return { ...text(friendly(error)), ...(!externalAttempted ? { noExternalWrite: true } : {}) };
    }
    finally { connection?.close(); }
  }
  async function readback({ input }, context, output) {
    let connection;
    try {
      // Only an actual execution result can attest to a pre-I/O no-op; timeout output is null.
      if (output?.noExternalWrite === true && typeof output.text === 'string') return text(output.text);
      const command = parse(input);
      if (READS.has(command.action)) return await query(command.action, context);
      const state = load(context);
      const operation = state.operations.find(o => o.requestID === context.requestID);
      if (!operation || operation.digest !== createHash('sha256').update(input).digest('hex')) return null;
      if (command.action === 'open') return null; // macOS acknowledgement is not proof of visible UI.
      if (command.action === 'use') return state.current === command.value ? text(`已核实当前插件会话 ${command.value}。`) : null;
      if (['blocked-busy', 'blocked-unknown', 'already-idle'].includes(operation.phase)) return output ?? text('本次没有发送问题。用 /status 或 /reply 查询当前会话。');
      const session = state.sessions.find(s => s.id === operation.threadId);
      if (!session) return null;
      const rows = await history(session.id, context);
      if (command.action === 'new' && !command.value) return text(`已核实新会话 ${session.id} 已创建。${state.current === session.id ? '当前插件会话为此会话。' : '当前插件会话已切换。'}`);
      connection = await connect(session.id, context);
      if (command.action === 'stop') return !connection.closed && !connection.busy ? text(`已核实会话 ${session.id} 当前未在生成。`) : null;
      const info = turnInfo(rows, { turn: operation.turn });
      if (!operation.turn || !info.verified) return null;
      return text(summary(rows, { ...session, turn: operation.turn }, connection));
    } catch { return null; }
    finally { connection?.close(); }
  }
  return { tools: {
    chat: { execute, readback },
    query: { async execute({ what = 'status' }, context) {
      try {
        if (!READS.has(what)) throw new FriendlyError('未知查询类型。');
        return await query(what, context);
      } catch (error) { return text(friendly(error)); }
    } },
  } };
}
function friendly(error) {
  if (error instanceof FriendlyError) return error.message;
  return '无法完成本次操作，可能是 Alma 未启动、连接中断、等待超时或调用被取消。若已尝试发送，结果未知；用 /reply 或 /status 续查，不要自动重发。';
}
export default createPlugin();
