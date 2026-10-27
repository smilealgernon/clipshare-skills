#!/usr/bin/env node
/**
 * ClipShare: clipboard and file drop between machines.
 *
 *   node <skill dir>/scripts/clipshare.mjs help
 *
 * Node 20+ only. Uses the legacy-compatible REST API plus the v2 file lifetime call.
 *
 * CLIPSHARE_URL    server, default https://q3.1o24.com
 * CLIPSHARE_TOKEN  optional API token (cs_...), created under 账号设置 → API 令牌. With it, new
 *                  clipboards belong to that account: files live 1 day instead of 1 hour, can be
 *                  kept longer, and the clipboard can be private. Sites need it.
 *
 * Instead of the environment, `clipshare.mjs login` (run by the user in their own terminal)
 * stores the token in ~/.config/clipshare/config.json, readable only by the user.
 */

import { execFileSync } from 'node:child_process';
import fs, { openAsBlob } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const CONFIG_FILE = path.join(os.homedir(), '.config', 'clipshare', 'config.json');
const readConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
};
const config = readConfig();
const BASE = (process.env.CLIPSHARE_URL || config.url || 'https://q3.1o24.com').replace(/\/+$/, '');
const TOKEN = process.env.CLIPSHARE_TOKEN || config.token || '';
const TOKEN_SOURCE = process.env.CLIPSHARE_TOKEN ? 'CLIPSHARE_TOKEN' : config.token ? CONFIG_FILE : '';
const KEEP = ['1h', '1d', '7d', '30d', 'forever'];

const die = message => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};

const usage = () => {
  console.log(`ClipShare helper (${BASE})

Usage:
  clipshare.mjs whoami
  clipshare.mjs login                       (the user runs this in their own terminal)
  clipshare.mjs logout
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
  clipshare.mjs sites
  clipshare.mjs publish <dir|site.zip> [--slug name] [--name title] [--spa] [--password pw]
  clipshare.mjs update-site <slug> <dir|site.zip>
  clipshare.mjs delete-site <slug>

Environment:
  CLIPSHARE_URL    default https://q3.1o24.com
  CLIPSHARE_TOKEN  API token (cs_...); without it (and without login) everything is anonymous`);
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


const requireToken = what =>
  TOKEN || die(`${what} needs an API token. Ask the user to create one under 账号设置 → API 令牌 at ${BASE}/settings and run "node <this script> login" in their own terminal.`);

// Read one line from the terminal without echoing it.
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) return reject(new Error('not a terminal'));
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const done = result => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stdout.write('\n');
      result instanceof Error ? reject(result) : resolve(result);
    };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(value.trim());
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on('data', onData);
  });
}

// Files of a site directory, as [relative posix path, absolute path]; skips VCS and dependencies.
function siteFiles(dir) {
  const skip = new Set(['.git', 'node_modules', '.DS_Store']);
  const out = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push([path.relative(dir, full).split(path.sep).join('/'), full]);
    }
  };
  walk(dir);
  return out;
}

async function siteForm(source, fields = {}) {
  if (!source || !fs.existsSync(source)) die(`site source not found: ${source}`);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) form.append(key, value);
  if (fs.statSync(source).isDirectory()) {
    const files = siteFiles(source);
    if (!files.length) die(`no files in ${source}`);
    if (!files.some(([rel]) => rel === 'index.html')) console.log('Note: no index.html at the top level.');
    for (const [rel, full] of files) form.append('files', await openAsBlob(full), rel);
    console.log(`Files: ${files.length}`);
  } else {
    if (!source.toLowerCase().endsWith('.zip')) die('a site is a directory or a .zip file');
    form.append('file', await openAsBlob(source), path.basename(source));
  }
  return form;
}

const showSite = site => {
  console.log(`Site: ${site.url}`);
  console.log(`Version: ${site.version}  Files: ${site.file_count}  Size: ${(site.size / 1024).toFixed(1)} KB`);
  if (site.has_password) console.log('Password: required');
};

const commands = {
  async whoami() {
    if (!TOKEN) return console.log(`anonymous (no CLIPSHARE_TOKEN, no ${CONFIG_FILE})`);
    const me = await call('GET', '/api/v2/me');
    console.log(`${me?.user?.email || JSON.stringify(me)} (token from ${TOKEN_SOURCE})`);
    const storage = me?.user?.storage;
    if (storage) {
      const mb = n => (n / 1024 / 1024).toFixed(1);
      console.log(`Storage: ${mb(storage.used)} MB of ${storage.quota ? `${mb(storage.quota)} MB` : 'unlimited'}`);
    }
  },

  async login() {
    let token;
    try {
      console.log(`Create a token at ${BASE}/settings (账号设置 → API 令牌), then paste it here.`);
      token = await readHidden('API token (input hidden): ');
    } catch (err) {
      die(err.message === 'cancelled' ? 'cancelled' : 'login reads the token from a terminal: run this command yourself, not through an agent');
    }
    if (!token.startsWith('cs_')) die('that does not look like a ClipShare token (cs_...)');
    const response = await fetch(`${BASE}/api/v2/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) die(`the server did not accept this token (${response.status})`);
    const me = await response.json();
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ url: BASE, token }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(CONFIG_FILE, 0o600);
    console.log(`Logged in as ${me.user.email}. Token saved to ${CONFIG_FILE} (only you can read it).`);
  },

  async logout() {
    if (!fs.existsSync(CONFIG_FILE)) return console.log('not logged in');
    fs.unlinkSync(CONFIG_FILE);
    console.log(`Removed ${CONFIG_FILE}`);
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

  async sites() {
    requireToken('Listing sites');
    const list = await call('GET', '/api/v2/sites');
    if (!list.sites.length) return console.log('no sites yet');
    for (const site of list.sites) {
      const flags = [site.has_password && 'password', site.disabled && 'disabled', site.blocked && 'blocked'].filter(Boolean);
      console.log(`${site.slug}  ${site.url}  v${site.version}  ${site.name || ''}${flags.length ? `  [${flags.join(', ')}]` : ''}`);
    }
  },

  async publish([source, ...rest]) {
    requireToken('Publishing a site');
    const fields = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--slug') fields.slug = rest[++i];
      else if (rest[i] === '--name') fields.name = rest[++i];
      else if (rest[i] === '--password') fields.password = rest[++i];
      else if (rest[i] === '--spa') fields.spa = 'true';
      else die(`unknown option: ${rest[i]}`);
    }
    showSite(await call('POST', '/api/v2/sites', { body: await siteForm(source, fields) }));
  },

  async 'update-site'([slug, source]) {
    requireToken('Updating a site');
    if (!slug || !source) die('usage: update-site <slug> <dir|site.zip>');
    showSite(await call('PUT', `/api/v2/sites/${slug}`, { body: await siteForm(source) }));
  },

  async 'delete-site'([slug]) {
    requireToken('Deleting a site');
    if (!slug) die('slug is required');
    await call('DELETE', `/api/v2/sites/${slug}`);
    console.log(`Deleted site ${slug}`);
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
