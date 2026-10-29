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
 * Instead of the environment, `clipshare.mjs login [token]` stores the token in
 * ~/.config/clipshare/config.json, readable only by the user.
 *
 * --json (anywhere on the command line) prints one JSON document instead of text.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const EXPIRE_HOURS = { '1h': 1, '1d': 24, '7d': 168, '30d': 720, never: null };
const JSON_OUT = process.argv.includes('--json');
const CHANNELS_FILE = path.join(os.homedir(), '.config', 'clipshare', 'channels.json');

const die = message => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};

const usage = () => {
  console.log(`ClipShare helper (${BASE})

Usage:
  clipshare.mjs whoami
  clipshare.mjs login [token]               (no token: asks for it, hidden)
  clipshare.mjs logout
  clipshare.mjs create [name] [--private]
  clipshare.mjs add-text <clipboard_id> <text>
  clipshare.mjs add-text <clipboard_id> --file <path>
  clipshare.mjs list-text <clipboard_id>
  clipshare.mjs pack <source_path> [output.tar.gz]
  clipshare.mjs upload <clipboard_id> <file_path> [more_files...] [--keep 1h|1d|7d|30d|forever] [--share [expire]]
  clipshare.mjs list-files <clipboard_id>
  clipshare.mjs info <file_id>
  clipshare.mjs download <file_id|share_url> [output_path] [--sha256 hex]
  clipshare.mjs share <clipboard_id|file_id> [--expire 1h|1d|7d|30d|never] [--password pw]
  clipshare.mjs shares <clipboard_id|file_id>
  clipshare.mjs unshare <share_id>
  clipshare.mjs keep <file_id> <1h|1d|7d|30d|forever>
  clipshare.mjs delete-file <file_id>
  clipshare.mjs delete-clipboard <clipboard_id>  (its text and files too)
  clipshare.mjs sites
  clipshare.mjs publish <dir|site.zip> [--slug name] [--name title] [--spa] [--password pw]
  clipshare.mjs update-site <slug> <dir|site.zip>
  clipshare.mjs delete-site <slug>

Channels (real-time messages between two agents; both must be online to connect):
  clipshare.mjs channel open [--as name] [--buffer hours]    (needs a token; prints an invite link)
  clipshare.mjs channel join <invite_url> [--as name]        (no token needed)
  clipshare.mjs channel listen <channel> [--once] [--timeout s]
  clipshare.mjs channel send <channel> <text...> [--file path] [--reply-to id] [--human]
  clipshare.mjs channel info|close|ws <channel>
  clipshare.mjs channel list
  <channel> is the id that open/join print; keys are kept in ${CHANNELS_FILE}

Add --json to any command for JSON output.

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
// UTC, marked with Z so nobody reads it as local time: 20261028-032403Z.
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z').replace('T', '-');

async function setKeep(fileId, keep) {
  if (!KEEP.includes(keep)) die(`keep must be one of ${KEEP.join(', ')}`);
  const file = await call('PATCH', `/api/v2/files/${fileId}`, { json: { keep } });
  say(`Expires: ${file.expires_at || 'never'}`);
  return file.expires_at || null;
}

// Text output; --json prints the result object of each command instead.
const say = line => JSON_OUT || console.log(line);
const result = data => JSON_OUT && console.log(JSON.stringify(data, null, 2));

async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// A share link that opens with one request: the password goes in the link.
const shareUrl = (token, password) => `${BASE}/s/${token}${password ? `?pw=${encodeURIComponent(password)}` : ''}`;

// "clipboard" or "file": ids look alike, so ask the server.
async function targetType(id) {
  const headers = authHeaders();
  if ((await fetch(`${BASE}/api/v2/clipboards/${id}`, { headers })).ok) return 'clipboard';
  if ((await fetch(`${BASE}/api/files/${id}/info`, { headers })).ok) return 'file';
  die(`no clipboard or file ${id} (or it is not yours)`);
}

async function createShare(type, id, expire, password) {
  requireToken('Sharing');
  if (!(expire in EXPIRE_HOURS)) die(`--expire must be one of ${Object.keys(EXPIRE_HOURS).join(', ')}`);
  const share = await call('POST', '/api/v2/shares', {
    json: { target_type: type, target_id: id, expires_in_hours: EXPIRE_HOURS[expire], password: password || null },
  });
  return { id: share.id, url: shareUrl(share.token, password), expires_at: share.expires_at };
}


// Channel keys by channel id, so commands take the short id. Readable only by the user: a key
// is the credential for its side of the channel.
const readChannels = () => {
  try {
    return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
  } catch {
    return {};
  }
};

// { <channel id>: { <my name>: {key, peer, url} } }: both sides may run on one machine.
function saveChannel(state, key) {
  const all = readChannels();
  all[state.channel] = { ...all[state.channel], [state.me]: { key, peer: state.peer, url: BASE } };
  fs.mkdirSync(path.dirname(CHANNELS_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(CHANNELS_FILE, 0o600);
}

function channelKey(ref, as) {
  if (!ref) die('channel id is required (see "channel list")');
  if (ref.startsWith('ch_')) return ref;
  const sides = readChannels()[ref] || die(`unknown channel ${ref}: not opened or joined on this machine`);
  if (as) return sides[as]?.key || die(`${as} is not in channel ${ref} on this machine`);
  const names = Object.keys(sides);
  if (names.length > 1) die(`both sides of channel ${ref} are on this machine: add --as ${names.join(' or --as ')}`);
  return sides[names[0]].key;
}

const channelRoute = (key, rest = '') => `/api/v2/channels/${encodeURIComponent(key)}${rest}`;
const wsUrl = key => `${BASE.replace(/^http/, 'ws')}${channelRoute(key, '/ws')}`;

// One line per event, so a watcher (Claude Code's Monitor) gets one notification per message.
function showEvent(event) {
  if (JSON_OUT) return console.log(JSON.stringify(event));
  if (event.type === 'state') {
    const peer = event.peer ? `${event.peer} ${event.peer_online ? 'online' : 'offline'}` : 'waiting for the other side';
    return console.log(`[${event.channel}] ${event.state}: ${peer}${event.paused ? ' (paused: a person must write next)' : ''}`);
  }
  const head = `[${event.channel} #${event.id} from ${event.from}${event.reply_to ? ` re #${event.reply_to}` : ''}]`;
  const lines = [];
  if (event.text) lines.push(event.text.replace(/\n/g, '\n    '));
  if (event.file) {
    const f = event.file;
    lines.push(`file ${f.name} (${f.size} bytes, sha256 ${f.sha256}): node ${process.argv[1]} download '${f.url}'`);
  }
  console.log(`${head} ${lines.join(' | ')}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    if (!files.some(([rel]) => rel === 'index.html')) say('Note: no index.html at the top level.');
    for (const [rel, full] of files) form.append('files', await openAsBlob(full), rel);
    say(`Files: ${files.length}`);
  } else {
    if (!source.toLowerCase().endsWith('.zip')) die('a site is a directory or a .zip file');
    form.append('file', await openAsBlob(source), path.basename(source));
  }
  return form;
}

const showSite = site => {
  say(`Site: ${site.url}`);
  say(`Version: ${site.version}  Files: ${site.file_count}  Size: ${(site.size / 1024).toFixed(1)} KB`);
  if (site.has_password) say('Password: required');
  result(site);
};

const commands = {
  async whoami() {
    if (!TOKEN) {
      say(`anonymous (no CLIPSHARE_TOKEN, no ${CONFIG_FILE})`);
      return result({ anonymous: true });
    }
    const me = await call('GET', '/api/v2/me');
    say(`${me?.user?.email || JSON.stringify(me)} (token from ${TOKEN_SOURCE})`);
    const storage = me?.user?.storage;
    if (storage) {
      const mb = n => (n / 1024 / 1024).toFixed(1);
      say(`Storage: ${mb(storage.used)} MB of ${storage.quota ? `${mb(storage.quota)} MB` : 'unlimited'}`);
    }
    result({ anonymous: false, email: me?.user?.email, token_source: TOKEN_SOURCE, storage: storage || null });
  },

  async login([given]) {
    let token = given?.trim();
    if (!token && !process.stdin.isTTY) token = fs.readFileSync(0, 'utf8').trim();
    if (!token) {
      try {
        console.log(`Create a token at ${BASE}/settings (账号设置 → API 令牌), then paste it here.`);
        token = await readHidden('API token (input hidden): ');
      } catch (err) {
        die(err.message === 'cancelled' ? 'cancelled' : 'no token: pass it as "login cs_..." or pipe it in');
      }
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
    say(`Clipboard ID: ${id}`);
    say(`Clipboard URL: ${BASE}/${id}`);
    say(`Owner: ${TOKEN ? 'token account' : 'anonymous (files live 1 hour)'}`);
    result({ id, url: `${BASE}/${id}`, private: priv, anonymous: !TOKEN });
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
    say(`Entry ID: ${idOf(entry)}`);
    say(`Clipboard URL: ${BASE}/${clipboardId}`);
    result({ id: idOf(entry), clipboard_url: `${BASE}/${clipboardId}` });
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
    const size = fs.statSync(archive).size;
    say(`Archive: ${archive}`);
    say(`Size: ${(size / 1024 / 1024).toFixed(2)} MB`);
    result({ path: archive, size });
  },

  async upload([clipboardId, ...rest]) {
    if (!clipboardId) die('clipboard_id is required');
    let keep = '';
    let share = '';
    const files = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--keep') keep = rest[++i] || '';
      else if (rest[i] === '--share') share = rest[i + 1] in EXPIRE_HOURS ? rest[++i] : '7d';
      else files.push(rest[i]);
    }
    if (!files.length) die('at least one file path is required');
    if (keep && !KEEP.includes(keep)) die(`--keep must be one of ${KEEP.join(', ')}`);
    for (const file of files) {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) die(`file not found: ${file}`);
    }
    const uploaded = [];
    for (const file of files) {
      say(`Uploading: ${file}`);
      const sha256 = await sha256File(file);
      const form = new FormData();
      form.append('file', await openAsBlob(file), path.basename(file));
      const payload = await call('POST', `/api/clipboards/${clipboardId}/files`, { body: form });
      const id = idOf(payload);
      if (!id) {
        show(payload);
        die('could not extract file id');
      }
      const item = { id, name: path.basename(file), sha256, download_url: `${BASE}/api/files/${id}` };
      say(`File ID: ${id}`);
      say(`SHA256: ${sha256}`);
      say(`Download URL: ${item.download_url}`);
      if (keep) item.expires_at = await setKeep(id, keep);
      if (share) {
        item.share = await createShare('file', id, share);
        say(`Share URL: ${item.share.url}  (no token needed, ${share === 'never' ? 'no expiry' : `expires in ${share}`})`);
        say(`Fetch: curl -fsSLOJ '${item.share.url}' && echo '${sha256}  ${item.name}' | sha256sum -c`);
      }
      uploaded.push(item);
    }
    say(`Clipboard URL: ${BASE}/${clipboardId}`);
    result({ clipboard_id: clipboardId, files: uploaded });
  },

  async 'list-files'([clipboardId]) {
    if (!clipboardId) die('clipboard_id is required');
    // The v2 view adds expires_at to each file.
    const clipboard = await call('GET', `/api/v2/clipboards/${clipboardId}`);
    for (const f of clipboard.files || []) {
      say(`${f.unique_id}  ${f.filename}  ${f.file_size} bytes  expires ${f.expires_at || 'never'}  sha256 ${f.sha256 || '-'}`);
    }
    result(clipboard.files || []);
  },

  async info([fileId]) {
    if (!fileId) die('file_id is required');
    show(await call('GET', `/api/files/${fileId}/info`));
  },

  async download(args) {
    let expected = '';
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--sha256') expected = (args[++i] || '').toLowerCase();
      else positional.push(args[i]);
    }
    const [source, output] = positional;
    if (!source) die('file_id or share URL is required');
    // A share link (/s/<token>...) or any full URL is fetched as is; a bare id is a file id.
    const isUrl = /^https?:\/\//.test(source);
    const url = isUrl ? source : `${BASE}/api/files/${source}`;
    let response;
    try {
      response = await fetch(url, { headers: isUrl ? {} : authHeaders(), redirect: 'follow' });
    } catch (err) {
      die(`GET ${url}\n${err.message}`);
    }
    if (!response.ok || !response.body) die(`GET ${url} -> ${response.status}\n${(await response.text()).slice(0, 500)}`);
    const disposition = response.headers.get('content-disposition') || '';
    if (!disposition.startsWith('attachment')) die(`${url} is not a file. It says:\n${(await response.text()).slice(0, 2000)}`);
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    const name = path.basename(star ? decodeURIComponent(star[1]) : plain ? plain[1] : '');
    const fileId = isUrl ? 'download' : source;

    // Never overwrite: keep the existing file and save the new one with a timestamp.
    let target = output || name || `clipshare-${fileId}`;
    if (!output && fs.existsSync(target)) {
      const ext = path.extname(target);
      target = `${target.slice(0, target.length - ext.length)}_${stamp()}${ext}`;
      say('Exists already, saving alongside it instead.');
    }
    // Streamed to disk: files can be several GB.
    const hash = createHash('sha256');
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      },
      fs.createWriteStream(target),
    );
    const sha256 = hash.digest('hex');
    // Check against what the caller expects, else against what the server stored.
    const want = expected || response.headers.get('x-content-sha256') || '';
    if (want && want !== sha256) {
      fs.renameSync(target, `${target}.bad`);
      die(`SHA256 mismatch: got ${sha256}, expected ${want}. Kept the download as ${target}.bad`);
    }
    say(`Saved: ${target}`);
    say(`Size: ${(fs.statSync(target).size / 1024 / 1024).toFixed(2)} MB`);
    say(`SHA256: ${sha256}${want ? ' (verified)' : ''}`);
    result({ path: target, size: fs.statSync(target).size, sha256, verified: Boolean(want) });
  },

  async share([id, ...rest]) {
    if (!id) die('usage: share <clipboard_id|file_id> [--expire 1h|1d|7d|30d|never] [--password pw]');
    let expire = '7d';
    let password = '';
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--expire') expire = rest[++i];
      else if (rest[i] === '--password') password = rest[++i];
      else die(`unknown option: ${rest[i]}`);
    }
    requireToken('Sharing');
    const type = await targetType(id);
    const share = await createShare(type, id, expire, password);
    const out = { ...share, target_type: type, target_id: id };
    say(`Share URL: ${share.url}`);
    say(`Share ID: ${share.id}  Expires: ${share.expires_at || 'never'}`);
    if (type === 'clipboard') {
      // The link lists the clipboard's files for curl, one download URL per line.
      const listing = await (await fetch(share.url)).text();
      out.files = listing
        .split('\n')
        .filter(line => line && !line.startsWith('#'))
        .map(line => {
          const [url, size, sha256, name] = line.split('\t');
          return { name, size: Number(size), sha256: sha256 === '-' ? null : sha256, url };
        });
      for (const f of out.files) say(`  ${f.name}: curl -fsSLOJ '${f.url}'`);
      say(`All files: curl -fsS '${share.url}' | grep -v '^#' | cut -f1 | xargs -n1 curl -fsSLOJ`);
    } else {
      say(`Fetch: curl -fsSLOJ '${share.url}'`);
    }
    result(out);
  },

  async shares([id]) {
    if (!id) die('usage: shares <clipboard_id|file_id>');
    requireToken('Listing shares');
    const type = await targetType(id);
    const list = (await call('GET', `/api/v2/shares?target_type=${type}&target_id=${id}`)).map(s => ({ ...s, target_type: type, target_id: id }));
    if (type === 'clipboard') {
      // upload --share links each file, so a clipboard's files count as its shares too.
      const clipboard = await call('GET', `/api/v2/clipboards/${id}`);
      for (const f of clipboard.files || []) {
        for (const s of await call('GET', `/api/v2/shares?target_type=file&target_id=${f.unique_id}`)) {
          list.push({ ...s, target_type: 'file', target_id: f.unique_id, filename: f.filename });
        }
      }
    }
    for (const s of list) {
      const what = s.target_type === 'file' && s.filename ? `  file ${s.filename}` : `  ${s.target_type}`;
      say(`${s.id}  ${shareUrl(s.token)}${what}  ${s.active ? 'active' : 'inactive'}  expires ${s.expires_at || 'never'}${s.has_password ? '  password' : ''}  opened ${s.view_count}x`);
    }
    if (!list.length) say('no share links');
    result(list);
  },

  async unshare([shareId]) {
    if (!shareId) die('usage: unshare <share_id>');
    requireToken('Revoking a share');
    await call('DELETE', `/api/v2/shares/${shareId}`);
    say(`Revoked share ${shareId}`);
    result({ revoked: Number(shareId) });
  },

  async keep([fileId, keep]) {
    if (!fileId || !keep) die('usage: keep <file_id> <1h|1d|7d|30d|forever>');
    await setKeep(fileId, keep);
  },

  async 'delete-file'([fileId]) {
    if (!fileId) die('file_id is required');
    await call('DELETE', `/api/files/${fileId}`);
    say(`Deleted file ${fileId}`);
    result({ deleted: fileId, type: 'file' });
  },

  async 'delete-clipboard'([clipboardId]) {
    if (!clipboardId) die('clipboard_id is required');
    await call('DELETE', `/api/v2/clipboards/${clipboardId}`);
    say(`Deleted clipboard ${clipboardId} with its text and files`);
    result({ deleted: clipboardId, type: 'clipboard' });
  },

  async sites() {
    requireToken('Listing sites');
    const list = await call('GET', '/api/v2/sites');
    if (!list.sites.length) say('no sites yet');
    for (const site of list.sites) {
      const flags = [site.has_password && 'password', site.disabled && 'disabled', site.blocked && 'blocked'].filter(Boolean);
      say(`${site.slug}  ${site.url}  v${site.version}  ${site.name || ''}${flags.length ? `  [${flags.join(', ')}]` : ''}`);
    }
    result(list.sites);
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
    say(`Deleted site ${slug}`);
    result({ deleted: slug, type: 'site' });
  },

  async channel([sub, ...rest]) {
    const opts = { text: [] };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--as') opts.as = rest[++i];
      else if (a === '--buffer') opts.buffer = Number(rest[++i]);
      else if (a === '--file') opts.file = rest[++i];
      else if (a === '--reply-to') opts.replyTo = Number(rest[++i]);
      else if (a === '--timeout') opts.timeout = Number(rest[++i]);
      else if (a === '--human') opts.human = true;
      else if (a === '--once') opts.once = true;
      else if (opts.ref === undefined) opts.ref = a;
      else opts.text.push(a);
    }
    const name = opts.as || process.env.CLIPSHARE_AGENT || os.hostname().split('.')[0];

    if (sub === 'open') {
      requireToken('Opening a channel');
      const body = { as: name, ...(opts.buffer ? { buffer_hours: opts.buffer } : {}) };
      const state = await call('POST', '/api/v2/channels', { json: body });
      saveChannel(state, state.key);
      say(`Channel: ${state.channel} (you are ${state.me})`);
      say(`Invite: ${state.invite_url}`);
      say(`The other side joins with: node clipshare.mjs channel join '${state.invite_url}' --as <name>`);
      say(`Stay online until it joins: node ${process.argv[1]} channel listen ${state.channel}`);
      say(`(Claude Code: Monitor({ws: {url: "${wsUrl(state.key)}"}}) instead of listen)`);
      return result({ ...state, ws_url: wsUrl(state.key) });
    }
    if (sub === 'join') {
      if (!opts.ref) die('usage: channel join <invite_url> [--as name]');
      const state = await call('POST', '/api/v2/channels/join', { json: { invite: opts.ref, as: name } });
      saveChannel(state, state.key);
      say(`Channel: ${state.channel}, connected to ${state.peer} (you are ${state.me})`);
      say(`Listen: node ${process.argv[1]} channel listen ${state.channel}`);
      return result({ ...state, ws_url: wsUrl(state.key) });
    }
    if (sub === 'list') {
      const rows = Object.entries(readChannels()).flatMap(([id, sides]) =>
        Object.entries(sides).map(([me, c]) => ({ id, me, peer: c.peer, url: c.url })),
      );
      if (JSON_OUT) return result(rows);
      for (const r of rows) console.log(`${r.id}\t${r.me} <-> ${r.peer || '?'}\t${r.url}`);
      return;
    }

    const key = channelKey(opts.ref, opts.as);
    if (sub === 'info') return showEvent(await call('GET', channelRoute(key)));
    if (sub === 'ws') return console.log(wsUrl(key));
    if (sub === 'close') {
      const state = await call('DELETE', channelRoute(key));
      say(`Closed channel ${state.channel}`);
      return result(state);
    }
    if (sub === 'send') {
      const text = opts.text.join(' ');
      let message;
      if (opts.file) {
        if (!fs.existsSync(opts.file)) die(`file not found: ${opts.file}`);
        const form = new FormData();
        form.append('file', await openAsBlob(opts.file), path.basename(opts.file));
        form.append('text', text);
        if (opts.replyTo) form.append('reply_to', String(opts.replyTo));
        if (opts.human) form.append('human', 'true');
        message = await call('POST', channelRoute(key, '/messages'), { body: form });
      } else {
        if (!text) die('usage: channel send <channel> <text...> [--file path]');
        const json = { text, reply_to: opts.replyTo || null, human: !!opts.human };
        message = await call('POST', channelRoute(key, '/messages'), { json });
      }
      say(`Sent #${message.id}${message.delivered ? '' : ' (the other side is offline: it gets the message when it reconnects)'}`);
      return result(message);
    }
    if (sub === 'listen') {
      // Long-poll. Without a cursor the server resumes after the last message this side
      // confirmed; each request confirms what the previous one returned.
      const deadline = opts.timeout ? Date.now() + opts.timeout * 1000 : Infinity;
      let cursor = null;
      let lastState = '';
      let failures = 0;
      let first = true;
      while (Date.now() < deadline) {
        const wait = Math.max(1, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
        const query = `?wait=${wait}${cursor === null ? '' : `&after=${cursor}`}`;
        let response;
        try {
          response = await fetch(`${BASE}${channelRoute(key, '/messages')}${query}`);
        } catch (err) {
          // Stay on: the server keeps the messages until we are back.
          console.error(`connection failed (${err.message}), retrying`);
          await sleep(Math.min(30000, 1000 * 2 ** failures++));
          continue;
        }
        if (response.status >= 500) {
          await sleep(Math.min(30000, 1000 * 2 ** failures++));
          continue;
        }
        if (!response.ok) die(`listen -> ${response.status}\n${(await response.text()).slice(0, 500)}`);
        failures = 0;
        const batch = await response.json();
        const state = JSON.stringify([batch.state.state, batch.state.peer, batch.state.paused]);
        const changed = state !== lastState;
        if (changed) {
          lastState = state;
          showEvent(batch.state);
        }
        batch.messages.forEach(showEvent);
        cursor = batch.cursor;
        if (batch.state.state === 'closed') break;
        // --once: back to the agent at the first message, or when the other side joins or leaves.
        if (opts.once && (batch.messages.length || (changed && !first))) break;
        first = false;
      }
      if (cursor !== null) {
        // Confirm the last batch before exiting, so the next listen does not repeat it.
        await fetch(`${BASE}${channelRoute(key, '/messages')}?after=${cursor}`).catch(() => {});
      }
      return;
    }
    die(`unknown channel command: ${sub || '(none)'}; see help`);
  },

  async help() {
    usage();
  },
};

const [command = 'help', ...args] = process.argv.slice(2).filter(a => a !== '--json');
const run = commands[command] || (['--help', '-h'].includes(command) ? commands.help : null);
if (!run) {
  usage();
  die(`unknown command: ${command}`);
}
await run(args);
