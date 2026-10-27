---
name: clipshare
description: Move files and text between machines that share no filesystem through ClipShare (https://q3.1o24.com by default) — a build artifact, an installer, a log, a stack trace — over its MCP server (/mcp), a Node helper, or plain curl, with optional API-token login for private clipboards and files kept longer than an hour. Use when the user gives a ClipShare link or clipboard id, asks to send something to another machine or agent ("传给我", "发个链接", "传到服务器上"), or asks to set up the ClipShare MCP.
---

# ClipShare

ClipShare holds **clipboards**: a clipboard has text entries and files, and
each one has a URL that works from any machine. The public server is
`https://q3.1o24.com`; `CLIPSHARE_URL` points everything below at another
deployment (replace the host in the examples).

## Rules of the server

- **Files delete themselves.** Anonymous clipboard: 1 hour after upload. A
  clipboard owned by an account: 1 day by default, and the owner can change a
  file to `1h`, `1d`, `7d`, `30d` or `forever`. Text entries do not expire.
  Upload right before the far side fetches, or use a token and `--keep`.
- **Accounts and API tokens.** The user registers on the site and creates a
  token under 账号设置 → API 令牌 (`cs_...`). Send it as
  `Authorization: Bearer cs_...`. With it, new clipboards belong to that
  account and can be **private** (only the token's account can read them).
  A wrong token is an error, never a silent fall back to anonymous.
- **Previews** of files come from a separate origin. Use `/api/files/<id>`
  for downloads, not preview links.
- Uploads up to 10 GB.

Never ask the user to paste a token into the chat. Ask them to put it in the
environment (`CLIPSHARE_TOKEN`) or the MCP client config themselves. Do not
write a token into a repository file.

## Right after installing: the API token

Without a token everything works anonymously: files go after 1 hour, nothing
is private, and sites cannot be published. When the skill has just been
installed, or the user wants private clipboards, longer-lived files or a site,
run `node $H whoami` (see Helper script for `$H`). If it says `anonymous`,
walk the user through these steps, in the user's language, and wait for them:

1. Open `https://q3.1o24.com/settings` (log in or register first), find
   「API 令牌」, type a name such as the machine's name, click 生成, and copy
   the `cs_...` token. It is shown once.
2. In **their own terminal window** (not through you: the token must not
   enter this conversation), run the login command with the full path of
   the helper filled in, for example:
   `node ~/.agents/skills/clipshare/scripts/clipshare.mjs login`
   and paste the token at the hidden prompt. It is checked against the server
   and saved to `~/.config/clipshare/config.json`, readable only by them.
3. Tell you when it is done; run `node $H whoami` again to confirm the account.

Print the exact login command for this machine (resolve `$H` first). In Claude
Code, a `!` command cannot read hidden input, so it has to be a separate
terminal. Setting `CLIPSHARE_TOKEN` in their shell profile works too;
`node $H logout` removes the saved token.

## MCP

Streamable HTTP, stateless, at `https://q3.1o24.com/mcp`. No token: works on
anonymous and link-visible clipboards. With a token: also the account's private
clipboards, and new clipboards belong to the account.

Tools: `create_clipboard`, `get_clipboard_info`, `update_clipboard`,
`add_clipboard_entry`, `list_clipboard_entries`, `get_entry`, `get_entry_info`,
`update_entry`, `delete_entry`, `list_clipboard_files`, `get_file_info`,
`get_file_download_url`, `delete_file`. There is **no upload tool**: files go up
over HTTP (helper or curl below); MCP then lists them and gives download URLs.

Setting it up is a change to the user's agent configuration — say what you
will add and get a yes first.

```bash
# Claude Code (user scope = every project)
claude mcp add --scope user --transport http clipshare https://q3.1o24.com/mcp
# with a token (the user runs this, so the token stays out of the transcript)
claude mcp add --scope user --transport http clipshare https://q3.1o24.com/mcp \
  --header "Authorization: Bearer $CLIPSHARE_TOKEN"
```

Other clients (Cursor, Codex, opencode, …) take the same URL as an HTTP /
Streamable HTTP server, for example:

```json
{ "mcpServers": { "clipshare": { "url": "https://q3.1o24.com/mcp",
  "headers": { "Authorization": "Bearer cs_..." } } } }
```

Leave out `headers` for anonymous use. Quick check without a client:

```bash
curl -s https://q3.1o24.com/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
```

## Helper script

Node 20+, no other dependencies. `scripts/clipshare.mjs` sits next to this file;
set `H` to its full path (for example `~/.agents/skills/clipshare/scripts/clipshare.mjs`
or `~/.claude/skills/clipshare/scripts/clipshare.mjs`, wherever the skill was installed).

```bash
H=<this skill's directory>/scripts/clipshare.mjs
node $H help
node $H whoami                                  # token account, or "anonymous"
node $H create "build handoff" [--private]      # prints Clipboard ID and URL
node $H upload CLIPBOARD_ID dist/app.zip [more files] [--keep 7d]
node $H list-files CLIPBOARD_ID                 # id, name, size, expiry
node $H add-text CLIPBOARD_ID --file notes.md   # long or multiline text: always --file
node $H list-text CLIPBOARD_ID
node $H info FILE_ID
node $H download FILE_ID [output_path]          # streamed; never overwrites
node $H keep FILE_ID forever                    # owner only (needs the token)
node $H delete-file FILE_ID                     # ask first
node $H pack ./logs /tmp/logs.tar.gz            # directories must be packed first
node $H login                                   # the user runs this in their own terminal
node $H logout
```

`CLIPSHARE_TOKEN` turns on the account features; `CLIPSHARE_URL` points it at
another deployment. `upload` prints a `Download URL` per file — that link is
what the far side wants. `download` without an output path uses the original
name and, when that name exists, saves next to it with a timestamp.

`keep` and `--keep` fail with "先认领这个剪贴板" on an anonymous clipboard:
anonymous files always live 1 hour.

Write archives to a scratch directory, never into a worktree.

## Sites

A site is a folder of static files (`index.html` at the top) served at
`https://<slug>.1o24.page`. Publishing needs the token (see above) and a
verified email; each account has a storage limit (default 1 GB) that files
and sites share.

```bash
node $H sites                                          # slug, URL, version
node $H publish ./dist --slug my-demo --name "Demo"    # a folder or a .zip
node $H publish ./dist --spa                           # unknown paths serve index.html
node $H publish ./dist --password secret123            # visitors need the password
node $H update-site my-demo ./dist                     # new version, same URL
node $H delete-site my-demo                            # ask first
```

Publish the build output (`dist/`, `build/`, `out/`), not the source tree;
`.git` and `node_modules` are skipped. Without `--slug` the server picks a
random one. Publishing puts the folder on the public internet: check what is
in it first (no `.env`, keys or private data) and say what will go up. The
last three versions are kept and can be restored on the site's page
(`/sites`).

## Plain HTTP

For a machine with only curl (add `-H "Authorization: Bearer $CLIPSHARE_TOKEN"`
to any call to act as the account):

```bash
B=https://q3.1o24.com
curl -sS -X POST $B/api/clipboards -H 'Content-Type: application/json' -d '{"name":"handoff"}'
curl -sS -X POST $B/api/clipboards/CLIPBOARD_ID/entries -H 'Content-Type: application/json' -d '{"content":"text"}'
curl -sS -F 'file=@artifact.zip' $B/api/clipboards/CLIPBOARD_ID/files
curl -sS $B/api/clipboards/CLIPBOARD_ID/files
curl -sS $B/api/files/FILE_ID/info
curl -fL -o artifact.zip $B/api/files/FILE_ID
# v2 only
curl -sS $B/api/v2/clipboards/CLIPBOARD_ID                     # files with expires_at
curl -sS -X PATCH $B/api/v2/files/FILE_ID -H "Authorization: Bearer $CLIPSHARE_TOKEN" \
  -H 'Content-Type: application/json' -d '{"keep":"7d"}'
```

Create answers with the clipboard under a `clipboard` key; upload answers with
the file object. Both carry the id as `unique_id`. `curl -O -J` overwrites a
file of the same name; on a server name the target with `-o`.

## What not to put on it

Uploading is publishing: a link-visible clipboard opens for anyone with the
id. Ask first, every time, and say what will go up. A private clipboard limits
who can read it but is still a copy on someone else's server.

- Never upload secrets: `.env` files, filled-in config, keys, certificates,
  tokens, customer database dumps, intranet host lists.
- Never upload HAR captures or logs with `Authorization` headers, cookies,
  session ids or passwords. Scrub output first; `tar` redacts nothing.
- Pack the minimum: no whole repositories, `node_modules`, `.git`, or state
  directories under `~`.
- A download writes to the machine it runs on. Say where it lands first.
- Deleting an entry or file needs the user's word, the same as uploading.
