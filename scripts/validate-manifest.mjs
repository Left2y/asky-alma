import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Offline counterpart of Asky PluginManifest.validate(at:), with stricter release checks.
// Contract: Niall-Young/Asky e85a67e4c9b5c29eb8127a19662f1d2fd2968095.
export async function validateManifest(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const data = await readFile(resolve(root, 'asky-plugin.json'));
  assert.ok(data.length <= 128 * 1024, 'manifest exceeds host limit');
  const m = JSON.parse(data);
  const valid = s => typeof s === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(s);
  const unique = a => new Set(a).size === a.length;
  assert.ok(m.apiVersion === 1 && valid(m.id) && m.name && m.version && m.tools?.length);
  assert.ok(unique(m.tools.map(t => t.name)));
  assert.ok(unique((m.configuration ?? []).map(f => f.key)));
  async function resource(path) {
    assert.ok(typeof path === 'string' && !path.startsWith('/'));
    const file = await realpath(resolve(root, path));
    assert.ok(file.startsWith((await realpath(root)) + sep) && (await stat(file)).isFile());
    return file;
  }
  await resource(m.entry);
  if (m.instructions) assert.ok((await stat(await resource(m.instructions))).size <= 64 * 1024);
  for (const f of m.configuration ?? []) {
    assert.ok(valid(f.key) && ['text', 'path', 'boolean', 'enum'].includes(f.type));
    if (f.type === 'enum') assert.ok(f.options?.length);
  }
  const implementation = (await import(pathToFileURL(resolve(root, m.entry)))).default;
  for (const t of m.tools) {
    assert.ok(valid(t.name) && t.inputSchema.type === 'object');
    assert.ok(Number.isInteger(t.timeoutSeconds ?? 20) && (t.timeoutSeconds ?? 20) >= 1 && (t.timeoutSeconds ?? 20) <= 240);
    assert.ok(['read', 'write'].includes(t.effect));
    assert.ok(t.effect === 'read' ? t.confirmation === 'never' : ['always', 'createDirectOtherwiseConfirm', 'explicitDirectOtherwiseConfirm'].includes(t.confirmation));
    assert.equal(typeof implementation.tools[t.name].execute, 'function');
    if (t.effect === 'write') assert.equal(typeof implementation.tools[t.name].readback, 'function');
  }
  assert.ok((m.commands ?? []).length <= 64 && unique((m.commands ?? []).map(c => c.name)));
  const reserved = ['confirmed', 'approved', 'userConfirmed', '_confirmed', 'confirmation'];
  for (const c of m.commands ?? []) {
    const t = m.tools.find(t => t.name === c.tool);
    assert.ok(valid(c.name) && c.title.trim() && (!c.keyword || valid(c.keyword)) && t);
    assert.ok(['action', 'search'].includes(c.mode) && (c.mode !== 'search' || t.effect === 'read'));
    assert.ok(!c.queryArgument || (!reserved.includes(c.queryArgument) && t.inputSchema.properties?.[c.queryArgument]?.type === 'string'));
    assert.ok((t.inputSchema.required ?? []).every(k => typeof k === 'string' && k === c.queryArgument));
  }
  return m;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await validateManifest();
  console.log('Manifest and entry contract validated.');
}
