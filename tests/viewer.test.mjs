import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export default class', 'return class');

function setup(options = { file: '/tmp/test.md' }, storage = new Map()) {
  const files = new Map([[options.file, '# Original']]);
  const pending = [];
  const cx = { notify() {}, timer: { every() {} }, spawn(fn) { pending.push(fn(this)); } };
  const state = { new({ value }) {
    const handlers = {};
    return { value: () => value, set_value(v) { value = v; },
      on(name, fn) { handlers[name] = fn; }, release() {},
      change(v) { value = v; handlers.change?.({}, cx); } };
  } };
  const localStorage = { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
  const Viewer = new Function('View', 'focused', 'home', 'props', 'readTextFile',
    'writeTextFile', 'InputState', 'EditorState', 'settings', 'localStorage', source)(
    class {}, () => ({ cwd: '/tmp' }), () => '/home/test', () => options,
    async path => files.get(path) ?? null,
    async (path, text, expected) => {
      if (files.get(path) !== expected) throw new Error('File changed externally');
      files.set(path, text);
    }, state, state, () => ({}), localStorage);
  const view = new Viewer();
  view.init({}, cx);
  const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return { view, cx, files, storage, settle };
}

test('edit, preview, save, and draft cleanup', async () => {
  const { view, cx, files, storage, settle } = setup();
  await settle(); view.edit(cx); view.editor.change('# Edited');
  assert.equal(view.text, '# Edited'); assert.ok(view.dirty()); assert.equal(storage.size, 1);
  view.mode = 'preview'; view.reload(cx); await settle();
  assert.equal(view.text, '# Edited');
  view.save(cx); await settle();
  assert.equal(files.get(view.file), '# Edited'); assert.equal(view.dirty(), false); assert.equal(storage.size, 0);
});

test('save conflict keeps disk content and draft; discard loads external changes', async () => {
  const { view, cx, files, storage, settle } = setup();
  await settle(); view.edit(cx); view.editor.change('# Draft');
  files.set(view.file, '# External'); view.save(cx); await settle();
  assert.equal(files.get(view.file), '# External'); assert.equal(view.text, '# Draft');
  assert.match(view.error, /Save failed/); assert.equal(storage.size, 1);
  view.open('/tmp/other.md', cx); assert.match(view.error, /Save or discard/);
  view.discard(cx); await settle();
  assert.equal(view.text, '# External'); assert.equal(storage.size, 0);
});

test('draft survives restart with its original conflict snapshot', async () => {
  const first = setup(); await first.settle(); first.view.edit(first.cx); first.view.editor.change('# Draft');
  const second = setup(undefined, first.storage); second.files.set('/tmp/test.md', '# External');
  await second.settle();
  assert.equal(second.view.text, '# Draft'); assert.equal(second.view.saved, '# Original');
  second.view.save(second.cx); await second.settle(); assert.match(second.view.error, /Save failed/);
});

test('a read already in flight cannot overwrite new edits', async () => {
  const { view, cx, settle } = setup(); await settle();
  view.reload(cx); view.edit(cx); view.editor.change('# New draft'); await settle();
  assert.equal(view.text, '# New draft'); assert.ok(view.dirty());
});

test('remote files remain read only; empty files refresh correctly', async () => {
  const remote = setup({ file: '/tmp/test.md', on: 'server' }); await remote.settle();
  remote.view.edit(remote.cx); assert.equal(remote.view.editor, null);
  const local = setup(); await local.settle(); local.files.set(local.view.file, '');
  local.view.reload(local.cx); await local.settle(); assert.equal(local.view.text, '');
});
