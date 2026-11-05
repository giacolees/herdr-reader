import { access, mkdtemp, open, appendFile, link, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep incomplete downloads separate and publish with an exclusive hard link.
// The destination and staging file share a filesystem; existing names never change.
export async function download({ action, folder, name, staging, destination, base64 }) {
  if (action === 'start') {
    if (!name || name === '.' || name === '..' || /[\\/\x00]/.test(name)) throw new Error('Invalid filename');
    destination = path.join(folder, name);
    try { await access(destination); throw new Error('A file or folder with this name already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    staging = await mkdtemp(path.join(folder, '.herdr-download-'));
    try { const file = await open(path.join(staging, 'partial'), 'wx'); await file.close(); }
    catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
    return { staging, destination };
  }
  if (action === 'append') {
    await appendFile(path.join(staging, 'partial'), Buffer.from(base64, 'base64'));
  } else if (action === 'finish') {
    try { await link(path.join(staging, 'partial'), destination); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('A file or folder with this name already exists');
      throw error;
    }
    await rm(staging, { recursive: true, force: true });
  } else if (action === 'abort') {
    await rm(staging, { recursive: true, force: true });
  } else throw new Error('Unknown download action');
  return {};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await download(JSON.parse(await readFile(process.argv[2], 'utf8'))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
