import { readFile, writeFile, mkdir, readdir, lstat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { marked } from 'marked';
import sharp from 'sharp';
const run = promisify(execFile);

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function cleanupCache(cache) {
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const name of await readdir(cache)) {
    if (!/^[a-f0-9]{64}\.(png|mmd)$/.test(name)) continue;
    const file = path.join(cache, name);
    try {
      const info = await lstat(file);
      if (info.isFile() && info.mtimeMs < cutoff) await unlink(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export async function render({ text, file, root, dark = false }) {
  const cache = path.join(root, 'data/md-viewer/media');
  await mkdir(cache, { recursive: true });
  const blocks = [];
  const markdown = text => {
    if (!text) return;
    const previous = blocks.at(-1);
    if (previous?.type === 'markdown') previous.text += text;
    else if (text.trim()) blocks.push({ type: 'markdown', text });
  };
  async function picture(source, alt, diagram = false) {
    try {
      let bytes;
      if (diagram) {
        const key = createHash('sha256').update('transparent-2x-v2:' + source + dark).digest('hex');
        const output = path.join(cache, key + '.png');
        try { bytes = await readFile(output); await utimes(output, new Date(), new Date()); } catch {
          const input = path.join(cache, key + '.mmd');
          await writeFile(input, source);
          await run(process.execPath, [fileURLToPath(new URL('node_modules/@mermaid-js/mermaid-cli/src/cli.js', import.meta.url)), '-i', input, '-o', output, '-t', dark ? 'dark' : 'default', '-b', 'transparent', '-s', '2', '-q'], { timeout: 20000, maxBuffer: 1024 * 1024 });
          bytes = await readFile(output);
        }
        // Keep the source with a reused diagram, using mtime as last-used time.
        try { await utimes(path.join(cache, key + '.mmd'), new Date(), new Date()); } catch {}
      } else if (/^https?:\/\//i.test(source)) {
        const response = await fetch(source, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
      } else if (source.startsWith('data:')) {
        const match = /^data:image\/[^;,]+(;base64)?,([\s\S]*)$/.exec(source);
        if (!match) throw new Error('Unsupported data URL');
        bytes = match[1] ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]));
      } else {
        const local = source.startsWith('file:') ? fileURLToPath(source) : path.resolve(path.dirname(file), decodeURIComponent(source));
        bytes = await readFile(local);
      }
      const png = await sharp(bytes, { limitInputPixels: 40000000 }).rotate().resize({ width: diagram ? 3200 : 1600, height: diagram ? 4800 : 2400, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
      const name = createHash('sha256').update(png.data).digest('hex') + '.png';
      await writeFile(path.join(cache, name), png.data);
      blocks.push({ type: 'image', path: 'data/md-viewer/media/' + name, width: png.info.width, height: png.info.height, pixelRatio: diagram ? 2 : 1, alt });
    } catch (error) {
      blocks.push({ type: 'error', text: `${diagram ? 'Mermaid diagram' : 'Image' + (alt ? ' “' + alt + '”' : '')}: ${String(error.message).slice(0, 300)}` });
      if (diagram) markdown('```mermaid\n' + source + '\n```');
    }
  }
  for (const token of marked.lexer(text)) {
    if (token.type === 'code' && token.lang?.trim().toLowerCase() === 'mermaid') {
      await picture(token.text, 'Mermaid diagram', true);
      continue;
    }
    // Let the Markdown parser identify images; fenced and inline code remain literal.
    const images = [];
    marked.walkTokens([token], child => { if (child.type === 'image') images.push(child); });
    let rest = token.raw;
    for (const image of images) {
      const offset = rest.indexOf(image.raw);
      if (offset < 0) continue;
      markdown(rest.slice(0, offset));
      await picture(image.href, image.text);
      rest = rest.slice(offset + image.raw.length);
    }
    markdown(rest);
  }
  // Cleanup is best effort: a maintenance failure must not hide the document.
  try { await cleanupCache(cache); } catch (error) { console.error('Cache cleanup:', error.message); }
  return blocks;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await render(JSON.parse(await readFile(process.argv[2], 'utf8'))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
