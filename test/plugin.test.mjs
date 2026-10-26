import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin } from '../index.mjs';
import { mockAlma, host } from './mock-alma.mjs';

async function fixture(t, options = {}) {
  const mock = await mockAlma();
  t.after(() => mock.close());
  const plugin = createPlugin({ baseURL: mock.baseURL, waitMs: 80, ioMs: 500, ...options });
  const h = host();
  const chat = (input, id) => plugin.tools.chat.execute({ input }, h.context(id));
  const readback = (input, id, output = null) => plugin.tools.chat.readback({ input }, h.context(id), output);
  const query = what => plugin.tools.query.execute({ what }, h.context());
  return { mock, plugin, h, chat, readback, query };
}

test('two independent calls continue the same persistent thread; readback never sends', async t => {
  const { mock, h, chat, readback, query } = await fixture(t);
  mock.onGenerate = () => assert.ok(h.saved.some(s => s.operations.at(-1)?.phase === 'sending'));
  assert.match((await chat('第一问', 'one')).text, /本轮回答/);
  const id = h.state.current;
  assert.equal(mock.threads.size, 1);
  assert.match((await readback('第一问', 'one')).text, /已在持久历史核实/);
  assert.match((await chat('第一问', 'one')).text, /本轮回答/);
  assert.equal(mock.writes.length, 1);
  assert.match((await chat('第二问', 'two')).text, /本轮回答/);
  assert.equal(h.state.current, id);
  assert.equal(mock.threads.size, 1);
  assert.deepEqual(mock.writes.map(w => w.data.threadId), [id, id]);
  assert.deepEqual(mock.writes[0].data.tools, ['__auto__']);
  assert.equal('noTools' in mock.writes[0].data, false);
  assert.match((await query('history')).text, /第一问[\s\S]*第二问/);
  assert.equal(mock.requests.some(r => r.path === '/api/threads' && r.method === 'GET'), false);
  assert.equal(JSON.stringify(h.state).includes('第一问'), false);
});

test('timeout leaves Alma running; late persisted reply recovers without a second send', async t => {
  const { mock, h, chat, readback, query } = await fixture(t);
  mock.mode = 'pending';
  const first = await chat('长任务', 'slow');
  assert.match(first.text, /本次等待已结束/);
  assert.equal(mock.threads.get(h.state.current).busy, true);
  assert.equal(mock.writes.filter(w => w.type === 'stop_generation').length, 0);
  assert.match((await readback('长任务', 'slow', first)).text, /正在生成/);
  mock.finish(h.state.current, '延迟完成的答案');
  assert.match((await query('reply')).text, /延迟完成的答案/);
  assert.match((await chat('长任务', 'slow')).text, /延迟完成的答案/);
  assert.equal(mock.writes.length, 1);
});

test('disconnect keeps checkpoint and later GET recovers; no retry or auto stop', async t => {
  const { mock, h, chat, query, readback } = await fixture(t);
  mock.mode = 'disconnect';
  assert.match((await chat('断线任务', 'disconnected')).text, /连接已断开/);
  mock.finish(h.state.current, '断线后结果');
  assert.match((await query('reply')).text, /断线后结果/);
  assert.match((await readback('断线任务', 'disconnected')).text, /断线后结果/);
  assert.equal(mock.writes.length, 1);
});

test('busy snapshot blocks steering and readback does not send', async t => {
  const { mock, h, chat, readback } = await fixture(t);
  await chat('/new', 'create');
  mock.threads.get(h.state.current).busy = true;
  const output = await chat('不要追加', 'blocked');
  assert.match(output.text, /正在生成，未发送/);
  await readback('不要追加', 'blocked', output);
  assert.equal(mock.writes.length, 0);
});

test('busy transition during state acknowledgement prevents sending and restores prior turn', async t => {
  const { mock, h, plugin, chat } = await fixture(t);
  await chat('已完成', 'first');
  const prior = h.state.sessions[0].turn;
  const context = h.context('racing');
  const original = context.saveState;
  context.saveState = async function (state) {
    await original.call(this, state);
    if (state.operations.at(-1).phase === 'sending') {
      mock.threads.get(h.state.current).busy = true;
      mock.broadcast('thread_generating', { id: h.state.current, isGenerating: true });
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  const output = await plugin.tools.chat.execute({ input: '竞争问题' }, context);
  assert.match(output.text, /未发送/);
  assert.equal(mock.writes.length, 1);
  assert.deepEqual(h.state.sessions[0].turn, prior);
});

test('other-thread completion, delta and error do not finish the current call', async t => {
  const { mock, h, chat } = await fixture(t, { waitMs: 1000 });
  mock.mode = 'pending';
  mock.onGenerate = () => {
    mock.broadcast('generation_completed', { threadId: 'unrelated' });
    mock.broadcast('generation_error', { threadId: 'unrelated', error: 'unrelated error' });
    mock.broadcast('message_delta', { threadId: 'unrelated', deltas: [{ text: 'unrelated answer' }] });
    mock.broadcast('thread_generating', { id: 'unrelated', isGenerating: false });
    setTimeout(() => mock.finish(h.state.current, '仅当前会话答案'), 40);
  };
  const output = await chat('隔离问题', 'isolation');
  assert.match(output.text, /仅当前会话答案/);
  assert.doesNotMatch(output.text, /unrelated/);
  assert.equal(mock.writes.length, 1);
});

test('stop targets only current owned thread and its readback never stops again', async t => {
  const { mock, h, chat, readback } = await fixture(t);
  mock.mode = 'pending';
  await chat('运行中', 'start');
  const current = h.state.current;
  const other = mock.seed('unrelated');
  mock.threads.get(other).busy = true;
  const stopped = await chat('/stop', 'stop');
  assert.match(stopped.text, /已停止/);
  assert.match((await readback('/stop', 'stop', stopped)).text, /当前未在生成/);
  assert.match((await chat('/stop', 'stop')).text, /当前未在生成/);
  assert.equal(mock.threads.get(other).busy, true);
  assert.deepEqual(mock.writes.filter(w => w.type === 'stop_generation').map(w => w.data.threadId), [current]);
});

for (const terminal of ['generation_completed', 'generation_error']) {
  test(`stop waits for idle after an earlier ${terminal} event`, async t => {
    const { mock, h, chat, readback } = await fixture(t);
    await chat('/new', 'create');
    const current = h.state.current;
    mock.threads.get(current).busy = true;
    let idleDelivered = false;
    mock.onStop = () => {
      mock.broadcast(terminal, { threadId: current });
      const timer = setTimeout(() => {
        idleDelivered = true;
        mock.threads.get(current).busy = false;
        mock.broadcast('thread_generating', { id: current, isGenerating: false });
      }, 20);
      t.after(() => clearTimeout(timer));
    };
    const stopped = await chat('/stop', 'stop');
    assert.match(stopped.text, /当前会话已停止生成/);
    assert.equal(idleDelivered, true);
    assert.equal(mock.threads.get(current).busy, false);
    assert.match((await readback('/stop', 'stop', stopped)).text, /当前未在生成/);
    assert.match((await chat('/stop', 'stop')).text, /当前未在生成/);
    assert.deepEqual(mock.writes.map(w => w.type), ['stop_generation']);
  });
}

for (const switchAction of ['new', 'use']) {
  test(`old new-request readback reflects current selection after /${switchAction}`, async t => {
    const { mock, h, chat, readback } = await fixture(t);
    await chat('/new', 'create-one');
    const first = h.state.current;
    const beforeSwitch = await readback('/new', 'create-one');
    assert.match(beforeSwitch.text, new RegExp(`已核实新会话 ${first} 已创建`));
    assert.match(beforeSwitch.text, /当前插件会话为此会话/);
    await chat('/new', 'create-two');
    const second = h.state.current;
    const oldRequest = switchAction === 'use' ? 'create-two' : 'create-one';
    const oldSession = switchAction === 'use' ? second : first;
    if (switchAction === 'use') await chat(`/use ${first}`, 'select');
    const current = h.state.current;
    const requestsBefore = mock.requests.length;
    for (const output of [await readback('/new', oldRequest), await chat('/new', oldRequest)]) {
      assert.match(output.text, new RegExp(`已核实新会话 ${oldSession} 已创建`));
      assert.match(output.text, /当前插件会话已切换/);
      assert.doesNotMatch(output.text, /已设为当前会话|当前插件会话为此会话/);
    }
    assert.equal(h.state.current, current);
    assert.equal(mock.threads.size, 2);
    assert.equal(mock.writes.length, 0);
    assert.deepEqual(mock.requests.slice(requestsBefore).map(r => r.method), ['GET', 'GET']);
  });
}

test('unknown send result returns null in readback and blocks another question', async t => {
  const { mock, h, chat, readback, query } = await fixture(t);
  mock.onGenerate = message => {
    const thread = mock.threads.get(message.data.threadId);
    thread.messages = []; thread.busy = false;
    mock.broadcast('thread_generating', { id: message.data.threadId, isGenerating: false });
  };
  mock.mode = 'pending';
  const output = await chat('未知问题', 'unknown');
  assert.match(output.text, /尚未核实/);
  assert.equal(await readback('未知问题', 'unknown', output), null);
  assert.match((await chat('未知问题', 'unknown')).text, /没有重发/);
  assert.match((await chat('另一问题', 'new-request')).text, /上一轮发送结果尚未核实/);
  assert.match((await query('reply')).text, /尚未核实/);
  assert.equal(mock.writes.length, 1);
  assert.equal(mock.threads.size, 1);
  assert.ok(h.state.sessions[0].turn.textHash);
});

test('a saveState failure before send cannot cause a write; later readback is read only', async t => {
  const { mock, h, plugin, chat, readback } = await fixture(t);
  await chat('/new', 'create');
  const context = h.context('state-failure');
  context.saveState = async () => { throw new Error('disk failed'); };
  await plugin.tools.chat.execute({ input: '不可发送' }, context);
  assert.equal(await readback('不可发送', 'state-failure'), null);
  assert.equal(mock.writes.length, 0);
});

test('unknown create response never automatically recreates during execute retry or readback', async t => {
  const { mock, chat, readback } = await fixture(t);
  mock.mode = 'create-disconnect';
  await chat('/new', 'create-unknown');
  assert.equal(await readback('/new', 'create-unknown'), null);
  await chat('/new', 'create-unknown');
  assert.match((await chat('不要隐式重建', 'next-question')).text, /上一次新建会话的结果尚未核实/);
  assert.equal(mock.threads.size, 1);
  assert.equal(mock.writes.length, 0);
});

test('thread selection stays in plugin registry and open uses fixed exec argv', async t => {
  const { mock, h, chat, readback, query } = await fixture(t);
  await chat('/new', 'create-one');
  const first = h.state.current;
  await chat('/new 第二个会话', 'create-two');
  assert.equal(mock.threads.size, 2);
  assert.match((await chat('/use unrelated', 'foreign')).text, /只能选择/);
  assert.match((await chat(`/use ${first}`, 'select')).text, /已选择/);
  assert.match((await readback(`/use ${first}`, 'select')).text, /已核实当前/);
  assert.equal(h.state.current, first);
  const output = await chat('/open', 'open');
  assert.match(output.text, /打开请求/);
  assert.deepEqual(h.execs, [['/usr/bin/open', [`alma://thread/${first}`], { timeoutSeconds: 10 }]]);
  assert.equal(await readback('/open', 'open', output), null);
  await chat('/open', 'open');
  assert.equal(h.execs.length, 1);
  assert.match((await query('threads')).text, new RegExp(first));
  assert.equal(mock.requests.some(r => r.path.includes('unrelated')), false);
});

test('missing snapshot fails closed; no send', async t => {
  const { mock, chat } = await fixture(t, { ioMs: 50 });
  await chat('/new', 'create');
  mock.snapshot = false;
  assert.match((await chat('不确定状态', 'missing')).text, /未提供生成状态快照/);
  assert.equal(mock.writes.length, 0);
});

test('cancellation after send never stops generation, and a later query recovers', async t => {
  const { mock, h, plugin, query, chat } = await fixture(t);
  await chat('/new', 'create');
  mock.mode = 'pending';
  const controller = new AbortController();
  mock.onGenerate = () => controller.abort();
  await plugin.tools.chat.execute({ input: '取消等待' }, h.context('cancelled', controller.signal));
  assert.equal(mock.writes.length, 1);
  assert.equal(mock.threads.get(h.state.current).busy, true);
  mock.finish(h.state.current, '取消后答案');
  assert.match((await query('reply')).text, /取消后答案/);
  assert.equal(mock.writes.length, 1);
});

test('help and bad commands perform no I/O; endpoint, ID and request argument safety', async t => {
  const { mock, h, plugin, chat, readback } = await fixture(t);
  assert.match((await chat('/help')).text, /单次最多 4 分钟/);
  const invalid = await chat('/wrong', 'invalid');
  assert.match(invalid.text, /未知命令/);
  assert.match((await readback('/wrong', 'invalid', invalid)).text, /未知命令/);
  assert.equal(await readback('/wrong', 'invalid', null), null);
  assert.equal(mock.requests.length, 0);
  assert.throws(() => createPlugin({ baseURL: 'http://example.com' }), /loopback/);
  assert.throws(() => createPlugin({ baseURL: 'http://127.0.0.1:23001/path' }), /loopback/);
  const unsafe = h.context('unsafe');
  unsafe.state = { version: 1, sessions: [{ id: 'x/../../settings' }], current: 'x/../../settings', operations: [] };
  assert.match((await plugin.tools.chat.execute({ input: '/open' }, unsafe)).text, /记录无效/);
  assert.equal(h.execs.length, 0);
  await chat('/new', 'same');
  assert.match((await chat('different', 'same')).text, /其他参数/);
  assert.equal(mock.writes.length, 0);
});

test('matching text before baseline is not mistaken for a new send', async t => {
  const { mock, h, chat, readback } = await fixture(t);
  await chat('重复问题', 'old');
  mock.mode = 'pending';
  mock.onGenerate = message => {
    const thread = mock.threads.get(message.data.threadId);
    thread.messages.pop(); thread.busy = false;
    mock.broadcast('thread_generating', { id: h.state.current, isGenerating: false });
  };
  const output = await chat('重复问题', 'new');
  assert.match(output.text, /尚未核实/);
  assert.equal(await readback('重复问题', 'new'), null);
  assert.equal(mock.writes.length, 2);
});

test('post-send readback failure stays pending and recovers when HTTP is available again', async t => {
  const { mock, h, chat, readback, query } = await fixture(t);
  mock.onGenerate = () => { mock.mode = 'history-fail'; mock.finish(h.state.current, '恢复结果'); };
  const output = await chat('回读中断', 'read-failure');
  assert.match(output.text, /HTTP 503/);
  assert.equal(await readback('回读中断', 'read-failure', output), null);
  mock.mode = 'complete';
  assert.match((await query('reply')).text, /恢复结果/);
  assert.match((await chat('回读中断', 'read-failure')).text, /恢复结果/);
  assert.equal(mock.writes.length, 1);
});

test('old request archived out of detailed checkpoints is never replayed', async t => {
  const { mock, h, plugin, chat } = await fixture(t);
  await chat('第一条', 'old-request');
  const context = h.context('old-request');
  context.state.operations = [];
  assert.match((await plugin.tools.chat.execute({ input: '第一条' }, context)).text, /已归档/);
  assert.equal(mock.writes.length, 1);
});

test('state frame stays within the host 512 KiB limit at documented retention caps', async () => {
  const sessions = Array.from({ length: 100 }, (_, i) => ({ id: `thread-${i}`, createdAt: new Date().toISOString(), turn: { requestID: 'a'.repeat(256), afterId: 'b'.repeat(128), textHash: 'c'.repeat(64) } }));
  const operations = Array.from({ length: 64 }, (_, i) => ({ requestID: `${i}`.padStart(256, 'a'), digest: 'd'.repeat(64), action: 'ask', phase: 'sending', threadId: 't'.repeat(128), turn: sessions[0].turn }));
  const seen = Array.from({ length: 2048 }, () => 'e'.repeat(64));
  assert.ok(Buffer.byteLength(JSON.stringify({ type: 'rpc', id: 1, method: 'state', value: { version: 1, current: 'thread-0', sessions, operations, seen } })) < 512 * 1024);
});

test('current-thread generation error is reported without resending', async t => {
  const { mock, chat, readback } = await fixture(t);
  mock.mode = 'pending';
  mock.onGenerate = message => mock.broadcast('generation_error', { threadId: message.data.threadId, error: 'private detail' });
  const output = await chat('失败任务', 'error');
  assert.match(output.text, /生成失败/);
  assert.doesNotMatch(output.text, /private detail/);
  assert.ok(await readback('失败任务', 'error'));
  assert.equal(mock.writes.length, 1);
});
