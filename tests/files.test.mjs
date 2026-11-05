import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../mods/md-files/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export default class', 'return class');
const Files = new Function('View', 'Reader', source)(class {}, class Reader {});

test('supported file clicks embed Reader and Back releases it without changing expanded folders', () => {
  const view = new Files();
  view.root = '/tmp/project'; view.on = null;
  view.folders = new Set(['images']);
  const opened = [];
  const cx = { notify() {}, new(Class, options) {
    const child = { options, released: false, release() { this.released = true; } };
    opened.push(child); return child;
  } };
  view.show('images/PHOTO.PNG', cx);
  assert.deepEqual(opened[0].options, { file: '/tmp/project/images/PHOTO.PNG', on: null, embedded: true });
  view.show(null);
  assert.equal(opened[0].released, true);
  assert.equal(view.reader, null);
  assert.equal(view.file, null);
  assert.deepEqual([...view.folders], ['images']);
  view.on = 'remote'; view.show('README.md', cx);
  assert.equal(opened[1].options.on, 'remote');
});

test('Files installs the same Reader implementation as the standalone pane', () => {
  assert.equal(readFileSync(new URL('../mods/md-files/reader.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../mods/reader/main.js', import.meta.url), 'utf8'));
});

async function creationSetup(root) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const FileActions = new Function('View', 'Reader', 'exec', 'window', source)(class {}, class {},
    async (cmd, args) => {
      try { const r = await run(cmd, args); return { ...r, code: 0 }; }
      catch (e) { return { code: e.code, stderr: e.stderr }; }
    }, () => ({ platform: 'macos' }));
  const view = new FileActions();
  view.context = { cwd: root, on: null }; view.root = root;
  view.current = context => context === view.context;
  view.folders = new Set();
  const loaded = []; view.loadFolder = async folder => loaded.push(folder);
  let value = '';
  view.createInput = { value: () => value, set_value: v => { value = v; } };
  const pending = [];
  const cx = { notify() {}, spawn(fn) { pending.push(fn(this)); } };
  return { view, cx, loaded, set: v => { value = v; }, settle: () => Promise.all(pending.splice(0)) };
}

test('creates folders and empty files; collisions preserve existing contents; names are literal', async () => {
  const { mkdtemp, readFile, stat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(tmpdir() + '/reader-create-');
  try {
    const { view, cx, loaded, set, settle } = await creationSetup(root);
    view.beginCreate('folder', cx); set('docs'); view.createEntry(cx); await settle();
    assert.ok((await stat(root + '/docs')).isDirectory());
    assert.ok(view.folders.has('docs')); assert.ok(loaded.includes(''));
    view.beginCreate('file', cx); set('docs/a $name `literal`.md'); view.createEntry(cx); await settle();
    assert.equal(await readFile(root + '/docs/a $name `literal`.md', 'utf8'), '');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(root + '/docs/a $name `literal`.md', 'keep me');
    view.beginCreate('file', cx); set('docs/a $name `literal`.md'); view.createEntry(cx); await settle();
    assert.ok(view.createError); assert.equal(view.creating, 'file');
    assert.equal(await readFile(root + '/docs/a $name `literal`.md', 'utf8'), 'keep me');
    view.beginCreate('folder', cx); set('docs'); view.createEntry(cx); await settle();
    assert.ok(view.createError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects absolute paths, traversal and empty names before creation', async () => {
  const { view, cx, set } = await creationSetup('/tmp');
  for (const name of ['', '../escape', '/absolute', 'a/../b', 'a//b', 'C:/absolute', 'a\\b']) {
    view.beginCreate('file', cx); set(name); view.createEntry(cx);
    assert.match(view.createError, /relative name/);
    assert.ok(!view.createBusy);
  }
});

test('Delete menu requires confirmation, removes folders recursively and keeps unrelated files', async () => {
  const { mkdtemp, writeFile, mkdir, access, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(tmpdir() + '/reader-delete-');
  try {
    await mkdir(root + '/docs'); await mkdir(root + '/docs/nested');
    await writeFile(root + '/docs/nested/file.md', 'delete');
    await writeFile(root + '/keep.md', 'keep');
    const { view, cx, loaded, settle } = await creationSetup(root);
    view.entries = new Map(); view.folders = new Set(['docs', 'docs/nested']);
    view.menu = { path: 'docs', dir: true };
    view.requestDelete(cx);
    assert.equal(view.menu, null); assert.equal(view.deleteTarget.path, 'docs');
    await access(root + '/docs/nested/file.md');
    view.deleteEntry(cx); await settle();
    await assert.rejects(access(root + '/docs'));
    assert.equal(await readFile(root + '/keep.md', 'utf8'), 'keep');
    assert.equal(view.deleteTarget, null); assert.equal(view.deleteBusy, false);
    assert.equal(view.folders.size, 0); assert.ok(loaded.includes(''));
    view.menu = { path: 'keep.md', dir: false }; view.requestDelete(cx);
    view.deleteEntry(cx); await settle(); await assert.rejects(access(root + '/keep.md'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed deletion keeps the confirmation and reports an error; stale contexts cannot delete', async () => {
  const { view, cx, settle } = await creationSetup('/tmp');
  view.menu = { path: 'reader-nonexistent-delete-test-file', dir: false };
  view.requestDelete(cx); view.deleteEntry(cx); await settle();
  assert.ok(view.deleteError); assert.ok(view.deleteTarget); assert.equal(view.deleteBusy, false);
  view.current = () => false; view.deleteError = '';
  view.deleteEntry(cx); await settle(); assert.equal(view.deleteError, '');
});

test('dropped files copy binary data, keep originals and report collisions without blocking other files', async () => {
  const { mkdtemp, writeFile, mkdir, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(tmpdir() + '/reader-drop-');
  try {
    await mkdir(root + '/source'); await mkdir(root + '/dest');
    const bytes = Buffer.from([0, 255, 10, 128]);
    await writeFile(root + '/source/image $1.png', bytes);
    await writeFile(root + '/source/exists.md', 'new');
    await writeFile(root + '/dest/exists.md', 'original');
    const { view, cx, settle, loaded } = await creationSetup(root + '/dest');
    view.importFiles([root + '/source/exists.md', root + '/source/image $1.png', root + '/source', root + '/missing'], cx);
    assert.equal(view.importBusy, true); await settle();
    assert.deepEqual(await readFile(root + '/dest/image $1.png'), bytes);
    assert.deepEqual(await readFile(root + '/source/image $1.png'), bytes);
    assert.equal(await readFile(root + '/dest/exists.md', 'utf8'), 'original');
    assert.match(view.importMessage, /Copied 1 file/);
    assert.match(view.importError, /already exists/);
    assert.match(view.importError, /Only files/);
    assert.match(view.importError, /missing/);
    assert.equal(view.importBusy, false); assert.ok(loaded.includes(''));
    view.importFiles([root + '/dest/image $1.png'], cx); await settle();
    assert.match(view.importError, /already exists/);
    assert.deepEqual(await readFile(root + '/dest/image $1.png'), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local drops into remote Files show a clear message without starting a copy', async () => {
  const { view, cx, settle } = await creationSetup('/tmp');
  view.on = 'server'; view.context.on = 'server';
  view.importFiles(['/local/photo.png'], cx); await settle();
  assert.match(view.importError, /Remote imports are not supported/);
  assert.ok(!view.importBusy);
});

test('opening a folder selects the copy destination; collapsing it returns to its parent', async () => {
  const { view, cx, settle } = await creationSetup('/tmp/project');
  view.entries = new Map(); view.pending = new Set();
  view.toggle('docs', cx); await settle();
  assert.equal(view.copyDestination(), '/tmp/project/docs');
  view.toggle('docs/images', cx); await settle();
  assert.equal(view.copyDestination(), '/tmp/project/docs/images');
  view.toggle('docs/images', cx);
  assert.equal(view.copyDestination(), '/tmp/project/docs');
  view.toggle('docs', cx);
  assert.equal(view.copyDestination(), '/tmp/project');
});

test('dropped files go into the selected folder, even if selection changes during copying', async () => {
  const { mkdtemp, writeFile, mkdir, readFile, access, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(tmpdir() + '/reader-drop-target-');
  try {
    await mkdir(root + '/dest'); await mkdir(root + '/dest/docs');
    await writeFile(root + '/note.md', 'content');
    const { view, cx, settle } = await creationSetup(root + '/dest');
    view.selectedFolder = 'docs'; view.folders.add('docs');
    view.importFiles([root + '/note.md'], cx);
    view.selectedFolder = '';
    await settle();
    assert.equal(await readFile(root + '/dest/docs/note.md', 'utf8'), 'content');
    await assert.rejects(access(root + '/dest/note.md'));
    assert.match(view.importMessage, /dest\/docs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dropping onto a specific closed folder overrides the selected destination without changing selection', async () => {
  const { mkdtemp, writeFile, mkdir, readFile, access, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(tmpdir() + '/reader-folder-drop-');
  try {
    await mkdir(root + '/dest'); await mkdir(root + '/dest/selected'); await mkdir(root + '/dest/target');
    await writeFile(root + '/note.md', 'folder drop');
    const { view, cx, settle } = await creationSetup(root + '/dest');
    view.selectedFolder = 'selected'; view.folders.add('selected');
    view.importFiles([root + '/note.md'], cx, 'target');
    await settle();
    assert.equal(await readFile(root + '/dest/target/note.md', 'utf8'), 'folder drop');
    await assert.rejects(access(root + '/dest/selected/note.md'));
    await assert.rejects(access(root + '/dest/note.md'));
    assert.equal(view.selectedFolder, 'selected');
    assert.equal(view.folders.has('target'), false);
    assert.match(view.importMessage, /dest\/target/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rename menu renames files and folders, preserves contents and refuses collisions', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, access, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(tmpdir() + '/reader-rename-');
  try {
    await mkdir(root + '/docs'); await mkdir(root + '/docs/nested');
    await writeFile(root + '/docs/nested/note.md', 'keep content');
    const { view, cx, set, settle } = await creationSetup(root);
    view.renameInput = view.createInput;
    view.entries = new Map([['docs', []], ['docs/nested', []]]);
    view.folders = new Set(['docs', 'docs/nested']); view.selectedFolder = 'docs/nested';
    view.menu = { path: 'docs', dir: true }; view.requestRename(cx);
    assert.equal(view.renameInput.value(), 'docs'); assert.equal(view.menu, null);
    set('renamed docs'); view.renameEntry(cx); await settle();
    assert.equal(await readFile(root + '/renamed docs/nested/note.md', 'utf8'), 'keep content');
    await assert.rejects(access(root + '/docs'));
    assert.equal(view.selectedFolder, 'renamed docs/nested');
    assert.ok(view.folders.has('renamed docs/nested'));
    view.menu = { path: 'renamed docs/nested/note.md', dir: false }; view.requestRename(cx);
    set('literal $name `test`.md'); view.renameEntry(cx); await settle();
    assert.equal(await readFile(root + '/renamed docs/nested/literal $name `test`.md', 'utf8'), 'keep content');
    await writeFile(root + '/renamed docs/nested/existing.md', 'existing');
    view.menu = { path: 'renamed docs/nested/literal $name `test`.md', dir: false }; view.requestRename(cx);
    set('existing.md'); view.renameEntry(cx); await settle();
    assert.match(view.renameError, /already exists/);
    assert.equal(await readFile(root + '/renamed docs/nested/existing.md', 'utf8'), 'existing');
    assert.equal(await readFile(root + '/renamed docs/nested/literal $name `test`.md', 'utf8'), 'keep content');
    set('../escape'); view.renameEntry(cx); assert.match(view.renameError, /without folder separators/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('internal dragging moves a file into a folder and never overwrites a collision', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, access, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(tmpdir() + '/reader-move-');
  try {
    await mkdir(root + '/target'); await writeFile(root + '/photo.png', Buffer.from([0, 255, 10]));
    const { view, cx, settle } = await creationSetup(root);
    view.startFileDrag('photo.png', { x: 10, y: 10 }, cx);
    view.trackFileDrag({ position: { x: 30, y: 40 } }, cx);
    assert.equal(view.dragActive, true);
    view.targetFileDrag('target', { x: 0, y: 30, width: 300, height: 28 }, cx);
    view.finishFileDrag(cx); await settle();
    await assert.rejects(access(root + '/photo.png'));
    assert.deepEqual(await readFile(root + '/target/photo.png'), Buffer.from([0, 255, 10]));
    assert.equal(view.dragFile, null); assert.equal(view.moveBusy, false);
    await writeFile(root + '/photo.png', 'second');
    view.moveFile('photo.png', 'target', view.context, cx); await settle();
    assert.match(view.moveError, /already exists/);
    assert.equal(await readFile(root + '/photo.png', 'utf8'), 'second');
    assert.deepEqual(await readFile(root + '/target/photo.png'), Buffer.from([0, 255, 10]));
    view.moveFile('target/photo.png', '', view.context, cx); await settle();
    assert.match(view.moveError, /already exists/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('clicks and cancelled or untargeted internal drags do not move files', async () => {
  const { view, cx, settle } = await creationSetup('/tmp');
  let moved = 0; view.moveFile = () => { moved++; };
  view.startFileDrag('note.md', { x: 0, y: 0 }, cx);
  view.targetFileDrag('docs', { x: 0, y: 0, width: 100, height: 30 }, cx);
  view.finishFileDrag(cx); assert.equal(moved, 0);
  view.startFileDrag('note.md', { x: 0, y: 0 }, cx);
  view.trackFileDrag({ position: { x: 20, y: 0 } }, cx);
  view.targetFileDrag('docs', { x: 0, y: 0, width: 100, height: 30 }, cx);
  view.trackFileDrag({ position: { x: 120, y: 40 } }, cx);
  assert.equal(view.dragTarget, null);
  view.finishFileDrag(cx); assert.equal(moved, 0);
  view.startFileDrag('note.md', { x: 0, y: 0 }, cx);
  view.trackFileDrag({ position: { x: 20, y: 0 } }, cx);
  view.targetFileDrag('docs', { x: 0, y: 0, width: 100, height: 30 }, cx);
  view.cancelFileDrag(cx); view.finishFileDrag(cx); await settle();
  assert.equal(moved, 0);
});

test('releasing on an explicit root target moves a nested file to root despite stale folder hover', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, access, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(tmpdir() + '/reader-move-root-');
  try {
    await mkdir(root + '/docs'); await writeFile(root + '/docs/note.md', 'root move');
    const { view, cx, settle } = await creationSetup(root);
    view.startFileDrag('docs/note.md', { x: 10, y: 80 }, cx);
    view.trackFileDrag({ position: { x: 30, y: 40 } }, cx);
    view.targetFileDrag('docs', { x: 0, y: 30, width: 300, height: 28 }, cx);
    view.finishFileDrag(cx, ''); await settle();
    assert.equal(await readFile(root + '/note.md', 'utf8'), 'root move');
    await assert.rejects(access(root + '/docs/note.md'));
    assert.match(view.moveMessage, /to root/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('browser menu is limited to local HTML files and passes literal paths to the helper', async () => {
  const calls = [];
  const BrowserFiles = new Function('View', 'Reader', 'exec', 'appHome', source)(class {}, class {},
    async (command, args) => { calls.push([command, args]); return { code: 0 }; }, () => '/app');
  const view = new BrowserFiles(); view.root = '/tmp'; view.on = null; view.context = {};
  view.current = context => context === view.context;
  const jobs = []; const cx = { notify() {}, spawn(fn) { jobs.push(fn(this)); } };
  for (const path of ['index.html', 'page.HTM', 'nested/Test.HTML']) assert.ok(view.canOpenInBrowser({ path, dir: false }));
  assert.equal(view.canOpenInBrowser({ path: 'folder.html', dir: true }), false);
  assert.equal(view.canOpenInBrowser({ path: 'readme.md', dir: false }), false);
  view.on = 'remote'; assert.equal(view.canOpenInBrowser({ path: 'index.html', dir: false }), false); view.on = null;
  view.menu = { path: 'a #1 $test.html', dir: false };
  view.openInBrowser(cx); await Promise.all(jobs);
  assert.equal(view.menu, null);
  assert.deepEqual(calls[0], ['node', ['/app/mods/reader/renderer/open-browser.mjs', '/tmp/a #1 $test.html']]);
});

test('HTML launcher uses configured browsers with encoded local URLs', async () => {
  const { openHtml } = await import('../renderer/open-browser.mjs');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const commands = [];
    openHtml('/tmp/a #1 $test.html', { platform, home: '/home/test', run(cmd, args) {
      commands.push([cmd, args]);
      if (cmd.includes('plutil')) return JSON.stringify({ LSHandlers: [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'org.mozilla.firefox' }] });
      if (cmd === 'xdg-settings') return 'firefox.desktop\n';
      return '';
    } });
    const last = commands.at(-1);
    if (platform === 'darwin') { assert.equal(last[0], '/usr/bin/open'); assert.equal(last[1][1], 'org.mozilla.firefox'); assert.match(last[1][2], /a%20%231%20/); }
    if (platform === 'linux') { assert.equal(last[0], 'gtk-launch'); assert.equal(last[1][0], 'firefox.desktop'); }
    if (platform === 'win32') { assert.equal(last[0], 'powershell'); assert.ok(last[1][2].includes('HKCU:'+String.fromCharCode(92)+'Software')); }
  }
});

test('Reveal in Finder selects local files and folders with literal paths and reports failures', async () => {
  const calls = []; let fail = false;
  const FinderFiles = new Function('View', 'Reader', 'exec', 'window', source)(class {}, class {},
    async (cmd, args) => { calls.push([cmd, args]); return { code: fail ? 1 : 0, stderr: fail ? 'Not found' : '' }; }, () => ({ platform: 'macos' }));
  const view = new FinderFiles(); view.root = '/tmp'; view.context = {}; view.current = c => c === view.context;
  const jobs = []; const cx = { notify() {}, spawn(fn) { jobs.push(fn(this)); } };
  for (const dir of [false, true]) {
    view.menu = { path: 'a #1 $test', dir }; assert.ok(view.canRevealInFinder());
    view.revealInFinder(cx); await Promise.all(jobs.splice(0));
    assert.equal(view.menu, null); assert.deepEqual(calls.at(-1), ['open', ['-R', '/tmp/a #1 $test']]);
  }
  view.on = 'remote'; view.menu = { path: 'file.md', dir: false };
  assert.equal(view.canRevealInFinder(), false); view.revealInFinder(cx); assert.equal(calls.length, 2);
  view.on = null; fail = true; view.revealInFinder(cx); await Promise.all(jobs.splice(0));
  assert.match(view.revealError, /Not found/);
});

test('Copy path copies the absolute local or SSH path for files and folders', () => {
  const view = new Files(), copied = [];
  const cx = { notify() {}, write_to_clipboard(text) { copied.push(text); } };
  view.root = '/srv/my project';
  for (const on of [null, 'server']) for (const dir of [false, true]) {
    view.on = on; view.menu = { path: 'nested/a \'$test #図', dir };
    view.copyPath(cx);
    assert.equal(copied.at(-1), '/srv/my project/nested/a \'$test #図');
    assert.equal(view.menu, null);
  }
});

async function downloadSetup(t, { cancel = false, failChunk = false } = {}) {
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const run = promisify(execFile);
  const root = await fs.mkdtemp(tmpdir() + '/reader-download-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(root + '/source'); await fs.mkdir(root + '/destination');
  const calls = [], jobs = [];
  const DownloadFiles = new Function('View', 'Reader', 'exec', 'appHome', 'pickFolder', 'mkdir', 'writeFile', 'unlink', source)(class {}, class {},
    async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'sh' && args[1].includes('dd ') && failChunk) return { code: 0, stdout: 'AAAA' };
      const argv = command === 'node' ? [fileURLToPath(new URL('../renderer/download.mjs', import.meta.url)), args[1]] : args;
      try { return { code: 0, ...await run(command, argv, { maxBuffer: 8 * 1024 * 1024 }) }; }
      catch (error) { return { code: error.code, stderr: error.stderr, stdout: error.stdout }; }
    }, () => root, async () => cancel ? null : root + '/destination', fs.mkdir, fs.writeFile, fs.unlink);
  const view = new DownloadFiles(); view.root = root + '/source'; view.on = 'server';
  view.context = { cwd: view.root, on: view.on }; view.current = c => c === view.context;
  const cx = { notify() {}, spawn(fn) { jobs.push(fn(this)); } };
  return { view, cx, root, calls, fs, settle: () => Promise.all(jobs.splice(0)) };
}

test('Download is SSH-only and transfers binary files larger than one chunk without changing the source', async t => {
  const { view, cx, root, calls, fs, settle } = await downloadSetup(t);
  const name = 'image \'$1 #100% 図.png', bytes = Buffer.alloc(2 * 1024 * 1024 + 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  await fs.writeFile(root + '/source/' + name, bytes);
  view.menu = { path: name, dir: false };
  view.on = null; assert.equal(view.canDownload(), false); view.downloadFile(cx); assert.equal(calls.length, 0);
  view.on = 'server'; view.menu.dir = true; assert.equal(view.canDownload(), false);
  view.menu.dir = false; assert.equal(view.canDownload(), true);
  view.downloadFile(cx); assert.equal(view.canDownload({ path: name, dir: false }), false);
  await settle();
  assert.equal(view.downloadError, '');
  assert.deepEqual(await fs.readFile(root + '/destination/' + name), bytes);
  assert.deepEqual(await fs.readFile(root + '/source/' + name), bytes);
  assert.equal(calls.filter(c => c.command === 'sh' && c.args[1].includes('dd ')).length, 3);
  assert.ok(calls.filter(c => c.command === 'sh').every(c => c.options.on === 'server'));
  assert.ok(calls.filter(c => c.command === 'node').every(c => c.options === undefined));
  assert.deepEqual(await fs.readdir(root + '/destination'), [name]);
  assert.deepEqual(await fs.readdir(root + '/data/md-viewer'), []);
  assert.match(view.downloadMessage, /Downloaded to/);
  assert.equal(view.downloadBusy, false);
});

test('downloads handle empty files and refuse existing destination names', async t => {
  const { view, cx, root, fs, settle } = await downloadSetup(t);
  await fs.writeFile(root + '/source/empty.txt', '');
  view.menu = { path: 'empty.txt', dir: false }; view.downloadFile(cx); await settle();
  assert.equal(await fs.readFile(root + '/destination/empty.txt', 'utf8'), '');
  await fs.writeFile(root + '/destination/empty.txt', 'keep');
  view.menu = { path: 'empty.txt', dir: false }; view.downloadFile(cx); await settle();
  assert.match(view.downloadError, /already exists/);
  assert.equal(await fs.readFile(root + '/destination/empty.txt', 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(root + '/destination'), ['empty.txt']);
});

test('cancelled folder selection starts no transfer; incomplete downloads remove partial files', async t => {
  const cancelled = await downloadSetup(t, { cancel: true });
  cancelled.view.menu = { path: 'file.png', dir: false };
  cancelled.view.downloadFile(cancelled.cx); await cancelled.settle();
  assert.equal(cancelled.calls.length, 0); assert.equal(cancelled.view.downloadBusy, false);
  const failed = await downloadSetup(t, { failChunk: true });
  await failed.fs.writeFile(failed.root + '/source/file.png', 'content');
  failed.view.menu = { path: 'file.png', dir: false };
  failed.view.downloadFile(failed.cx); await failed.settle();
  assert.match(failed.view.downloadError, /Incomplete download/);
  assert.deepEqual(await failed.fs.readdir(failed.root + '/destination'), []);
  assert.deepEqual(await failed.fs.readdir(failed.root + '/data/md-viewer'), []);
});

test('a destination created during a download is preserved at publication', async t => {
  const { download } = await import('../renderer/download.mjs');
  const { root, fs } = await downloadSetup(t);
  const job = await download({ action: 'start', folder: root + '/destination', name: 'race.txt' });
  await download({ action: 'append', ...job, base64: Buffer.from('download').toString('base64') });
  await fs.writeFile(job.destination, 'created meanwhile');
  await assert.rejects(download({ action: 'finish', ...job }), /already exists/);
  await download({ action: 'abort', ...job });
  assert.equal(await fs.readFile(job.destination, 'utf8'), 'created meanwhile');
  assert.deepEqual(await fs.readdir(root + '/destination'), ['race.txt']);
});
