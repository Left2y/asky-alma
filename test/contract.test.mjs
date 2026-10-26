import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { validateManifest } from '../scripts/validate-manifest.mjs';
import { mockAlma } from './mock-alma.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('release manifest matches launcher, permissions and maximum timeout contract', async () => {
  const manifest = await validateManifest(root);
  assert.equal(manifest.tools.find(t => t.name === 'chat').timeoutSeconds, 240);
  assert.equal(manifest.commands[0].keyword, 'alma');
  assert.equal(manifest.commands[0].mode, 'action');
  assert.equal(manifest.tools.find(t => t.name === 'query').effect, 'read');
});

// Optional: use a real Asky runner selected explicitly by the maintainer. Never installs Asky.
test('real Asky runner saves state through RPC and readback is a separate read-only process', { skip: !process.env.ASKY_PLUGIN_RUNNER }, async t => {
  const mock = await mockAlma();
  t.after(() => mock.close());
  const temporary = await mkdtemp(join(tmpdir(), 'asky-alma-runner-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const entry = join(temporary, 'fixture.mjs');
  await writeFile(entry, `import { createPlugin } from ${JSON.stringify(new URL('../index.mjs', import.meta.url).href)};\nexport default createPlugin({baseURL:${JSON.stringify(mock.baseURL)},waitMs:100,ioMs:500});\n`);
  const manifest = await validateManifest(root);
  let state = {};
  let rpcs = 0;
  async function run(input, { readback = false, output = null } = {}) {
    const child = spawn(process.execPath, [process.env.ASKY_PLUGIN_RUNNER], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    const lines = createInterface({ input: child.stdout });
    const result = new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('runner timed out')); }, 5000);
      child.on('error', reject);
      child.on('close', () => { clearTimeout(timer); reject(new Error(`runner ended without result: ${stderr}`)); });
      lines.on('line', line => {
        const frame = JSON.parse(line);
        if (frame.type === 'rpc') {
          assert.equal(frame.method, 'state');
          rpcs++; state = frame.value;
          child.stdin.write(`${JSON.stringify({ id: frame.id, value: true })}\n`);
        }
        if (frame.type === 'result') {
          clearTimeout(timer);
          if (frame.error) reject(new Error(frame.error)); else resolveResult(frame.value);
        }
      });
    });
    child.stdin.write(`${JSON.stringify({ entry, tool: 'chat', arguments: { input }, inputSchema: manifest.tools[0].inputSchema, configuration: {}, requestID: 'runner-stable-request', state, readback, output })}\n`);
    return result;
  }
  const output = await run('runner 测试');
  assert.match(output.text, /本轮回答/);
  assert.ok(rpcs >= 4);
  assert.equal(mock.writes.length, 1);
  assert.match((await run('runner 测试', { readback: true, output })).text, /已在持久历史核实/);
  assert.match((await run('runner 测试')).text, /本轮回答/);
  assert.equal(mock.writes.length, 1);
  assert.equal(mock.threads.size, 1);
});
