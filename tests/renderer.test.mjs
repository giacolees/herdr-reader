import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, utimes, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from '../renderer/node_modules/sharp/lib/index.js';
import { render, remoteImagePaths } from '../renderer/render.mjs';

test('relative and reference images render; code examples stay literal; missing images report errors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'md-viewer-'));
  try {
    await writeFile(path.join(root, 'test image.png'), await sharp({ create: { width: 40, height: 20, channels: 4, background: '#ff0000' } }).png().toBuffer());
    const blocks = await render({ root, file: path.join(root, 'test.md'), text: '![local](test%20image.png)\n\n![reference][pic]\n\n[pic]: <test image.png>\n\n`![code](missing.png)`\n\n```js\n![code](missing.png)\n```\n\n![missing](missing.png)' });
    assert.equal(blocks.filter(b => b.type === 'image').length, 2);
    assert.equal(blocks.filter(b => b.type === 'error').length, 1);
    assert.ok(blocks.some(b => b.type === 'markdown' && b.text.includes('```js')));
    assert.equal(blocks.find(b => b.type === 'image').width, 40);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Mermaid flowchart and sequence render locally; invalid Mermaid preserves source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'md-mermaid-'));
  try {
    const blocks = await render({ root, file: path.join(root, 'test.md'), text: '```mermaid\nflowchart LR\n A-->B\n```\n\n```mermaid\nsequenceDiagram\n Alice->>Bob: Hello\n```\n\n```mermaid\nnot a diagram\n```' });
    assert.equal(blocks.filter(b => b.type === 'image').length, 2);
    for (const block of blocks.filter(b => b.type === 'image')) {
      const { data, info } = await sharp(path.join(root, block.path)).raw().toBuffer({ resolveWithObject: true });
      assert.equal(block.pixelRatio, 2);
      assert.equal(info.width, block.width);
      assert.ok(block.width > 300, 'diagram should have a high resolution raster');
      assert.equal(info.channels, 4);
      assert.equal(data[3], 0, 'diagram corner should be transparent');
    }
    assert.equal(blocks.filter(b => b.type === 'error').length, 1);
    assert.ok(blocks.some(b => b.type === 'markdown' && b.text.includes('not a diagram')));
    const cache = path.join(root, 'data/md-viewer/media');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const name of await readdir(cache)) await utimes(path.join(cache, name), old, old);
    const reused = await render({ root, file: path.join(root, 'test.md'), text: '```mermaid\nflowchart LR\n A-->B\n```' });
    assert.equal(reused[0].path, blocks.find(b => b.type === 'image').path);
    const retained = await readdir(cache);
    assert.equal(retained.length, 3, 'reused diagram, preview and source should survive cleanup');
    assert.ok(retained.includes(path.basename(reused[0].path)));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('render removes generated cache files unused for 24 hours and retains recent and unrelated files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'md-cache-'));
  const cache = path.join(root, 'data/md-viewer/media');
  try {
    await mkdir(cache, { recursive: true });
    const expired = ['a'.repeat(64) + '.png', 'b'.repeat(64) + '.mmd'];
    const recent = 'c'.repeat(64) + '.png';
    const unrelated = 'keep.txt';
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const name of [...expired, recent, unrelated]) await writeFile(path.join(cache, name), 'test');
    for (const name of [...expired, unrelated]) await utimes(path.join(cache, name), old, old);
    await render({ root, file: path.join(root, 'test.md'), text: '# Cleanup' });
    assert.deepEqual((await readdir(cache)).sort(), [recent, unrelated].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('standalone image files render with dimensions, orientation and readable failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-viewer-'));
  try {
    const file = path.join(root, 'photo #1 100%.jpg');
    await sharp({ create: { width: 80, height: 40, channels: 3, background: '#336699' } })
      .jpeg().withMetadata({ orientation: 6 }).toFile(file);
    const blocks = await render({ root, file, imageFile: true });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'image');
    assert.equal(blocks[0].alt, 'photo #1 100%.jpg');
    assert.equal(blocks[0].width, 40);
    assert.equal(blocks[0].height, 80);
    const failed = await render({ root, file: path.join(root, 'missing.png'), imageFile: true });
    assert.equal(failed[0].type, 'error');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SSH image planning resolves POSIX paths, references and file URLs without reading code examples', () => {
  const request = { file: '/srv/docs/test.md', text: '![one](../test%20image.png)\n\n![two][pic]\n\n[pic]: ../test%20image.png\n\n![absolute](/tmp/図.png)\n\n![file](file:///srv/image%20one.png)\n\n![web](https://example.com/image.png)\n\n![inline](data:image/png;base64,AAAA)\n\n`![code](inline.png)`\n\n```md\n![code](fenced.png)\n```' };
  assert.deepEqual(remoteImagePaths(request), ['/srv/test image.png', '/tmp/図.png', '/srv/image one.png']);
  assert.deepEqual(remoteImagePaths({ file: '/srv/100% #1.png', imageFile: true }), ['/srv/100% #1.png']);
});

test('SSH images use fetched bytes, preserve individual failures, and never fall back to local files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-render-'));
  try {
    const file = path.join(root, 'test.md');
    const local = path.join(root, 'local.png');
    const base64 = (await sharp({ create: { width: 12, height: 6, channels: 3, background: '#336699' } }).png().toBuffer()).toString('base64');
    await writeFile(local, Buffer.from(base64, 'base64'));
    const blocks = await render({ root, file, text: '![remote](remote.png)\n\n![denied](denied.png)\n\n![local](local.png)\n\n![invalid](bad%ZZ.png)', remoteImages: {
      [path.join(root, 'remote.png')]: { base64 },
      [path.join(root, 'denied.png')]: { error: 'Permission denied' }
    } });
    assert.equal(blocks[0].type, 'image');
    assert.equal(blocks[0].width, 12);
    assert.equal(blocks.filter(b => b.type === 'error').length, 3);
    assert.ok(blocks.some(b => b.text?.includes('Permission denied')));
    assert.ok(blocks.some(b => b.text?.includes('not fetched')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
