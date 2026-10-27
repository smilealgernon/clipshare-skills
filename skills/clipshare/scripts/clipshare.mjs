#!/usr/bin/env node
/**
 * ClipShare: clipboard and file drop between machines.
 *
 *   node <skill dir>/scripts/clipshare.mjs help
 *
 * Node 20+ only. Uses the legacy-compatible REST API plus the v2 file lifetime call.
 *
 * CLIPSHARE_URL    server, default https://q3.1o24.com
 * CLIPSHARE_TOKEN  optional API token (cs_...), created under 设置 → API 令牌. With it, new
 *                  clipboards belong to that account: files live 1 day instead of 1 hour, can be
 *                  kept longer, and the clipboard can be private.
 */

import { execFileSync } from 'node:child_process';
import fs, { openAsBlob } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BASE = (process.env.CLIPSHARE_URL || 'https://q3.1o24.com').replace(/\/+$/, '');
const TOKEN = process.env.CLIPSHARE_TOKEN || '';
const KEEP = ['1h', '1d', '7d', '30d', 'forever'];

const die = message => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};

const usage = () => {
  console.log(`ClipShare helper (${BASE})

Usage:
  clipshare.mjs whoami
  clipshare.mjs create [name] [--private]
  clipshare.mjs add-text <clipboard_id> <text>
  clipshare.mjs add-text <clipboard_id> --file <path>
  clipshare.mjs list-text <clipboard_id>
  clipshare.mjs pack <source_path> [output.tar.gz]
  clipshare.mjs upload <clipboard_id> <file_path> [more_files...] [--keep 1h|1d|7d|30d|forever]
  clipshare.mjs list-files <clipboard_id>
  clipshare.mjs info <file_id>
  clipshare.mjs download <file_id> [output_path]
  clipshare.mjs keep <file_id> <1h|1d|7d|30d|forever>
  clipshare.mjs delete-file <file_id>

Environment:
  CLIPSHARE_URL    default https://q3.1o24.com
  CLIPSHARE_TOKEN  API token (cs_...); without it everything is anonymous`);
};

const authHeaders = (extra = {}) => (TOKEN ? { ...extra, Authorization: `Bearer ${TOKEN}` } : extra);

async function call(method, route, { json, body, headers } = {}) {
  const url = `${BASE}${route}`;
  const options = { method, headers: authHeaders(headers) };
  if (json !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(json);
  } else if (body !== undefined) {
    options.body = body;
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    die(`${method} ${url}\n${err.message}`);
  }
  const text = await response.text();
  if (!response.ok) die(`${method} ${url} -> ${response.status}\n${text.slice(0, 2000)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// New objects come back at the top level or under a key named after them.
const idOf = payload => {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.unique_id === 'string') return payload.unique_id;
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object' && typeof value.unique_id === 'string') return value.unique_id;
  }
  return '';
};

const show = payload => console.log(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

async function setKeep(fileId, keep) {
  if (!KEEP.includes(keep)) die(`keep must be one of ${KEEP.join(', ')}`);
  const file = await call('PATCH', `/api/v2/files/${fileId}`, { json: { keep } });
  console.log(`Expires: ${file.expires_at || 'never'}`);
}

const commands = {
  async whoami() {
    if (!TOKEN) return console.log('anonymous (CLIPSHARE_TOKEN not set)');
    const me = await call('GET', '/api/v2/me');
    console.log(me?.user?.email || JSON.stringify(me));
  },

  async create(args) {
    const priv = args.includes('--private');
    const name = args.filter(a => a !== '--private')[0] || 'Untitled Clipboard';
    if (priv && !TOKEN) die('--private needs CLIPSHARE_TOKEN: an anonymous clipboard cannot be private');
    const payload = await call('POST', '/api/v2/clipboards', { json: { name, visibility: priv ? 'private' : 'link' } });
    const id = idOf(payload);
    if (!id) {
      show(payload);
      die('could not extract clipboard id');
    }
    console.log(`Clipboard ID: ${id}`);
    console.log(`Clipboard URL: ${BASE}/${id}`);
    console.log(`Owner: ${TOKEN ? 'token account' : 'anonymous (files live 1 hour)'}`);
  },

  async 'add-text'([clipboardId, ...rest]) {
    if (!clipboardId) die('clipboard_id is required');
    let content;
    if (rest[0] === '--file') {
      const file = rest[1];
      if (!file || !fs.existsSync(file)) die(`text file not found: ${file}`);
      content = fs.readFileSync(file, 'utf8');
    } else {
      if (!rest.length) die('text or --file is required');
      content = rest.join(' ');
    }
    const entry = await call('POST', `/api/clipboards/${clipboardId}/entries`, { json: { content } });
    console.log(`Entry ID: ${idOf(entry)}`);
    console.log(`Clipboard URL: ${BASE}/${clipboardId}`);
  },

  async 'list-text'([clipboardId]) {
    if (!clipboardId) die('clipboard_id is required');
    show(await call('GET', `/api/clipboards/${clipboardId}/entries`));
  },

  async pack([source, output]) {
    if (!source) die('source_path is required');
    if (!fs.existsSync(source)) die(`source path does not exist: ${source}`);
    const resolved = path.resolve(source);
    const archive = output || `${path.basename(resolved)}-${stamp()}.tar.gz`;
    try {
      execFileSync('tar', ['-czf', archive, '-C', path.dirname(resolved), path.basename(resolved)], {
        stdio: 'inherit',
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      });
    } catch (err) {
      die(`tar failed: ${err.message}`);
    }
    console.log(`Archive: ${archive}`);
    console.log(`Size: ${(fs.statSync(archive).size / 1024 / 1024).toFixed(2)} MB`);
  },

  async upload([clipboardId, ...rest]) {
    if (!clipboardId) die('clipboard_id is required');
    let keep = '';
    const files = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--keep') keep = rest[++i] || '';
      else files.push(rest[i]);
    }
    if (!files.length) die('at least one file path is required');
    if (keep && !KEEP.includes(keep)) die(`--keep must be one of ${KEEP.join(', ')}`);
    for (const file of files) {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) die(`file not found: ${file}`);
    }
    for (const file of files) {
      console.log(`Uploading: ${file}`);
      const form = new FormData();
      form.append('file', await openAsBlob(file), path.basename(file));
      const payload = await call('POST', `/api/clipboards/${clipboardId}/files`, { body: form });
      const id = idOf(payload);
      if (!id) {
        show(payload);
        die('could not extract file id');
      }
      console.log(`File ID: ${id}`);
      console.log(`Download URL: ${BASE}/api/files/${id}`);
      if (keep) await setKeep(id, keep);
    }
    console.log(`Clipboard URL: ${BASE}/${clipboardId}`);
  },

  async 'list-files'([clipboardId]) {
    if (!clipboardId) die('clipboard_id is required');
    // The v2 view adds expires_at to each file.
    const clipboard = await call('GET', `/api/v2/clipboards/${clipboardId}`);
    for (const f of clipboard.files || []) {
      console.log(`${f.unique_id}  ${f.filename}  ${f.file_size} bytes  expires ${f.expires_at || 'never'}`);
    }
  },

  async info([fileId]) {
    if (!fileId) die('file_id is required');
    show(await call('GET', `/api/files/${fileId}/info`));
  },

  async download([fileId, output]) {
    if (!fileId) die('file_id is required');
    let name = '';
    if (!output) {
      const info = await call('GET', `/api/files/${fileId}/info`);
      if (info && typeof info === 'object' && info.filename) name = path.basename(String(info.filename));
    }
    const url = `${BASE}/api/files/${fileId}`;
    let response;
    try {
      response = await fetch(url, { headers: authHeaders(), redirect: 'follow' });
    } catch (err) {
      die(`GET ${url}\n${err.message}`);
    }
    if (!response.ok || !response.body) die(`GET ${url} -> ${response.status}`);

    // Never overwrite: keep the existing file and save the new one with a timestamp.
    let target = output || name || `clipshare-${fileId}`;
    if (!output && fs.existsSync(target)) {
      const ext = path.extname(target);
      target = `${target.slice(0, target.length - ext.length)}_${stamp()}${ext}`;
      console.log('Exists already, saving alongside it instead.');
    }
    // Streamed to disk: files can be several GB.
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target));
    console.log(`Saved: ${target}`);
    console.log(`Size: ${(fs.statSync(target).size / 1024 / 1024).toFixed(2)} MB`);
  },

  async keep([fileId, keep]) {
    if (!fileId || !keep) die('usage: keep <file_id> <1h|1d|7d|30d|forever>');
    await setKeep(fileId, keep);
  },

  async 'delete-file'([fileId]) {
    if (!fileId) die('file_id is required');
    show(await call('DELETE', `/api/files/${fileId}`));
  },

  async help() {
    usage();
  },
};

const [command = 'help', ...args] = process.argv.slice(2);
const run = commands[command] || (['--help', '-h'].includes(command) ? commands.help : null);
if (!run) {
  usage();
  die(`unknown command: ${command}`);
}
await run(args);
