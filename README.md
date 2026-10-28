# ClipShare skills

让 AI 助手用 [ClipShare](https://q3.1o24.com) 在机器之间传文本和文件。

## 安装

把这句话发给你的 AI 助手（Claude Code、Codex、Cursor 等）：

```
帮我安装 ClipShare skill：npx skills add smilealgernon/clipshare-skills -g，装好后带我配置 API 令牌
```

也可以自己在终端里运行 `npx skills add smilealgernon/clipshare-skills -g`。

## 用法

装好以后，直接说：

- “把 dist/app.zip 传上去，给我下载链接”
- “看一下剪贴板 aB3xQ9 里的报错日志”
- “下载剪贴板 aB3xQ9 里最新的文件到当前目录”
- “把 dist 目录发布成网站，地址用 my-demo”
- “把 gw.tar.gz 传到服务器上”（私有存放，生成一天有效的分享链接，服务器上一行 curl 下载并校验 sha256）

不配置令牌也能用，文件 1 小时后删除。想读写自己的私有剪贴板、生成分享链接、让文件留得更久、发布网站，就在 ClipShare 的「账号设置 → API 令牌」里生成一个令牌，然后运行 `node ~/.agents/skills/clipshare/scripts/clipshare.mjs login cs_你的令牌`，或者直接把令牌发给 AI 助手，让它替你登录。也可以设成环境变量 `CLIPSHARE_TOKEN`。

自己部署的服务器，设 `CLIPSHARE_URL` 指向它。

---

Agent skill for [ClipShare](https://q3.1o24.com): move text and files between machines.
Install with `npx skills add smilealgernon/clipshare-skills -g`. The skill files live in
`skills/clipshare`; this repository is generated from the ClipShare source.
