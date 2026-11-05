import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, unlink, rm, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(new URL('../mods/reader/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export default class', 'return class');

function setup(options = { file: '/tmp/test.md' }, storage = new Map(), media = {}) {
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
    'writeTextFile', 'InputState', 'EditorState', 'settings', 'localStorage',
    'exec', 'appHome', 'mkdir', 'writeFile', 'unlink', source)(
    class {}, () => ({ cwd: '/tmp' }), () => '/home/test', () => options,
    async path => files.get(path) ?? null,
    async (path, text, expected) => {
      if (files.get(path) !== expected) throw new Error('File changed externally');
      files.set(path, text);
    }, state, state, () => ({}), localStorage, media.exec, media.appHome, mkdir, writeFile, unlink);
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

test('standalone images open without reading binary data or exposing an editor', async () => {
  const { view, cx, settle } = setup({ file: '/tmp/PHOTO.PNG' });
  await settle();
  assert.equal(view.isImage, true);
  assert.equal(view.text, '');
  view.edit(cx);
  assert.equal(view.editor, null);
  assert.equal(view.dirty(), false);
  view.open('/tmp/test.md', cx);
  await settle();
  assert.equal(view.isImage, false);
  assert.equal(view.media, null);
});

test('opening an image cannot discard a dirty Markdown draft', async () => {
  const { view, cx, settle } = setup();
  await settle(); view.edit(cx); view.editor.change('# Draft');
  view.open('/tmp/photo.png', cx);
  assert.equal(view.file, '/tmp/test.md');
  assert.equal(view.text, '# Draft');
  assert.match(view.error, /Save or discard/);
});

const run = promisify(execFile);
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');

async function remoteSetup(t, { markdown = false, fail = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-ssh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, markdown ? 'test.md' : 'image \'$1 #100%.png');
  if (!markdown) await writeFile(file, pixel);
  const calls = [];
  const media = { appHome: () => root, async exec(command, args, options) {
    calls.push({ command, args, options });
    if (command === 'sh' && fail) throw new Error('SSH connection lost');
    const argv = command === 'node' ? [fileURLToPath(new URL('../renderer/render.mjs', import.meta.url)), args[1]] : args;
    try { return { code: 0, ...await run(command, argv, { maxBuffer: 8 * 1024 * 1024 }) }; }
    catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
  } };
  return { ...setup({ file, on: 'server' }, new Map(), media), root, calls };
}

test('SSH image preview transfers binary safely, renders locally, and refreshes', async t => {
  const { view, cx, settle, calls, root } = await remoteSetup(t);
  view.prepareMedia(cx); await settle();
  assert.equal(view.mediaError, '');
  assert.equal(view.media[0].type, 'image');
  assert.equal(view.media[0].width, 1);
  const remote = calls.find(c => c.command === 'sh');
  assert.deepEqual(remote.options, { on: 'server' });
  assert.equal(remote.args.at(-1), view.file);
  assert.ok(calls.filter(c => c.command === 'node').every(c => c.options === undefined));
  assert.deepEqual(await readdir(path.join(root, 'data/md-viewer')), ['media']);
  await unlink(view.file);
  view.mediaKey = ''; view.reload(cx); view.prepareMedia(cx); await settle();
  assert.equal(view.media[0].type, 'error');
  assert.match(view.media[0].text, /not a regular file/);
});

test('SSH Markdown resolves and deduplicates images while preserving text and errors', async t => {
  const { view, cx, files, settle, calls, root } = await remoteSetup(t, { markdown: true });
  await settle();
  await writeFile(path.join(root, 'test image.png'), pixel);
  files.set(view.file, '# Remote\n\n![one](test%20image.png)\n\n![two](test%20image.png)\n\n![missing](missing.png)');
  view.reload(cx); await settle();
  view.prepareMedia(cx); await settle();
  assert.equal(view.media.filter(b => b.type === 'image').length, 2);
  assert.equal(calls.filter(c => c.command === 'sh').length, 2);
  assert.ok(view.media.some(b => b.type === 'markdown' && b.text.includes('# Remote')));
  assert.ok(view.media.some(b => b.type === 'error' && b.text.includes('missing')));
  assert.equal(view.dirty(), false);
});

test('SSH failures are shown as image errors and leave no request files', async t => {
  const { view, cx, settle, root } = await remoteSetup(t, { fail: true });
  view.prepareMedia(cx); await settle();
  assert.match(view.media[0].text, /SSH connection lost/);
  assert.equal(view.mediaBusy, false);
  assert.deepEqual(await readdir(path.join(root, 'data/md-viewer')), ['media']);
});

test('opening another file cancels a stale remote preview and removes its request', async t => {
  const { view, cx, settle, root } = await remoteSetup(t);
  view.prepareMedia(cx);
  view.open(path.join(root, 'next.png'), cx);
  await settle();
  assert.equal(view.media, null);
  assert.deepEqual(await readdir(path.join(root, 'data/md-viewer')), []);
});

test('oversized SSH images report the transfer limit', async t => {
  const { view, cx, settle } = await remoteSetup(t);
  await writeFile(view.file, Buffer.alloc(5 * 1024 * 1024 + 1));
  view.prepareMedia(cx); await settle();
  assert.match(view.media[0].text, /5 MiB preview limit/);
});
