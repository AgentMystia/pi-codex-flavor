# pi-codex-flavor

给 [Pi](https://pi.dev) 用的编程扩展，当前版本 0.3.1。模型还是你自己在 Pi 里选的，这个包装的是写代码时旁边那一层。

你可以直接把任务交给它。它会在没弄清的时候问你，计划阶段只看不改，命令按权限跑，改文件留下能对上的差异，需要时按文件撤回。子代理可以接着干，审阅只看 diff。

需要 Node.js 22.19 或更新，以及 `@earendil-works/pi-coding-agent` 1.5.2。Linux 上的沙箱用系统里已经装好的 bubblewrap。它不会自己下载语言服务器或其他工具。

## 安装

```bash
pi install git:github.com/AgentMystia/pi-codex-flavor
```

装好后重新打开 Pi。已经开着的进程里，`/reload` 只会重新执行入口文件，之前加载的模块还在，所以要整进程重启一次。

只试一次、不写入配置：

```bash
pi -e git:github.com/AgentMystia/pi-codex-flavor
```

卸掉：

```bash
pi remove git:github.com/AgentMystia/pi-codex-flavor
```

## 怎么用

直接说要做的事。这些命令是给人用的：

| 命令 | 干什么 |
|---|---|
| `/permissions` | 选 Ask for Approval、Full Access 或 Read-Only |
| `/plan` | 切到只读计划。后面跟的文字会一起交进去 |
| `/codex-implement` | 按刚确认的计划做。加 `fresh` 会新开一轮再做 |
| `/subagent` | 给以后新开的子代理选模型和思考档 |
| `/codex-agents` | 看线程 |
| `/codex-questions` | 看问题 |
| `/codex-approvals` | 看执行批准 |
| `/codex-state` | 看任务、决定和验证 |
| `/codex-review` | 看工作区或暂存区的 diff |

`/permissions` 三档：

- **Ask for Approval**：工作区里可以改、可以跑隔离命令，网络默认关。要出沙箱或联网，再单独批一次。
- **Full Access**：用这台机器的环境，不再逐条问。计划模式和审阅仍然只读。
- **Read-Only**：不改文件，也不提权。

普通回答不会顺便给你执行权限。取消、超时、预选，都不算同意。简单命令可以在这次会话里记住，或者记住一个安全的前缀；带管道、重定向的命令还是会问。

主题叫 `codex-flavor`，在 Pi 里用 `/theme` 选。

## 启动时的设置

默认是工作区可写、网络关闭、需要时再批准。想用一份 JSON 固定这次启动，加上 `--codex-config`。文件放哪由你决定。

```json
{
  "approval": "on-request",
  "sandbox": "workspace-write",
  "network": false
}
```

会话里再用 `/permissions` 选档，会盖过这份文件里的审批、沙箱和网络。其余设置不动。

语言服务器只接你已经安装的。不写进配置，就不会启动，也不会多出工具。

## 来源

交互和提示词参考公开的 [OpenAI Codex](https://github.com/openai/codex)，固定在 2026-11-12 的提交 `c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee`。用到的原文、许可证和 NOTICE 在 `third_party/`。这不是 OpenAI 的产品。

实现是给 Pi 写的 JavaScript。沙箱起不来就直接失败，不会退回本机 shell。

## 许可

Apache-2.0。见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。

---

# pi-codex-flavor

A coding extension for [Pi](https://pi.dev), version 0.3.1. You keep choosing the model in Pi. This package is the layer around the work.

Hand it a task. It asks when something is unclear, stays read-only while planning, runs commands under a permission policy, records a diff for file edits, and can restore a file when the content still matches. Subagents can continue the work. Review looks at the diff.

You need Node.js 22.19 or newer, and `@earendil-works/pi-coding-agent` 1.5.2. On Linux the sandbox uses bubblewrap already installed on the system. It does not download language servers or other tools.

## Install

```bash
pi install git:github.com/AgentMystia/pi-codex-flavor
```

Open Pi again after installing. In a process that is already running, `/reload` only reruns the entry file. Modules loaded earlier stay in memory, so restart the process.

Try it once without saving the install:

```bash
pi -e git:github.com/AgentMystia/pi-codex-flavor
```

Remove it with:

```bash
pi remove git:github.com/AgentMystia/pi-codex-flavor
```

## Use

Say what you want done. These commands are the ones you type:

| Command | What it does |
|---|---|
| `/permissions` | Ask for Approval, Full Access, or Read-Only |
| `/plan` | Switch to read-only planning. Text after the command is submitted with it |
| `/codex-implement` | Carry out the plan you just accepted. `fresh` starts a new session with that plan |
| `/subagent` | Choose the model and thinking level for subagents started later |
| `/codex-agents` | Look at threads |
| `/codex-questions` | Look at questions |
| `/codex-approvals` | Look at execution approvals |
| `/codex-state` | Tasks, decisions, and verification |
| `/codex-review` | Workspace or staged diff |

The three permission modes:

- **Ask for Approval**: edit and run sandboxed commands inside the workspace. Network is off. Leaving the sandbox or opening the network takes a separate approval.
- **Full Access**: use this machine's environment, without asking for each command. Plan mode and review stay read-only.
- **Read-Only**: no file changes and no privilege escalation.

An ordinary answer does not grant execution permission. Cancel, timeout, and a preselected option are not consent. A simple command can be remembered for the session, or as a safe prefix. A command with a pipe or redirection is asked again.

The theme is `codex-flavor`. Pick it with `/theme`.

## Startup settings

The default is a writable workspace, network off, and approval when needed. Pass `--codex-config` with a JSON file if you want to fix those for one launch. You choose where the file lives.

```json
{
  "approval": "on-request",
  "sandbox": "workspace-write",
  "network": false
}
```

Choosing a mode with `/permissions` during the session overrides approval, sandbox, and network from that file. The rest stays as it was.

A language server is used only if you already have it and list it in that file. Leave it out, and no server starts and no extra tool appears.

## Source

The interaction and prompts follow the public [OpenAI Codex](https://github.com/openai/codex) tree, pinned to commit `c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee` from 2026-11-12. The upstream text, license, and NOTICE are in `third_party/`. This is not an OpenAI product.

The implementation is JavaScript for Pi. If the sandbox cannot start, the command fails. It does not fall back to a host shell.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
