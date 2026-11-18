# 当前提示词的来源与适配

本版从最新公开 Codex 仓库取得原文，不导出或推断任何未公开会话指令。

- 固定提交：`c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee`，提交时间 `2026-11-12T05:21:30Z`。
- 核心：`codex-rs/models-manager/models.json` 中 `gpt-6.1-sol.model_messages.instructions_template`。
- 子代理：同一模型的 `model_messages.multi_agent.role.subagent`。
- 显式代码审阅：同一提交的 `codex-rs/prompts/templates/review/rubric.md`。
- 计划/默认模式：同一提交的 `codex-rs/collaboration-mode-templates/templates/plan.md` 与 `default.md`；作为 `/plan` 切换时注入的 `<collaboration_mode>` 模式指令，适配差异见 `docs/prompt-adaptations.json` 的 `collaborationModes` 节。
- 上游原文、完整公开模型目录和哈希：`third_party/codex-current`。许可及 NOTICE 随运行包保留。

原文的持续完成任务、权限沿用、工作区协作、沟通风格、技术说明、PR 描述、上下文延续、选择有价值的验证、技能使用等部分直接保留，不用自行概括的规则替代。没有沿用旧 Cookbook/GPT-5.2 指南；工具实现历史来源仍保留以满足溯源，但其旧提示词不再用作当前系统指令。

| 必要改动 | 原因 |
|---|---|
| 去掉 Codex/GPT 身份声明 | 实际运行在 Pi，provider 和模型由用户选择 |
| 移除外部消息的 Codex 专属限制、自动审批审查及报告流程 | 插件没有对应审查服务；实际 OS 沙箱、执行批准和权限仍由工具落实 |
| commentary/final → Pi 普通进度文字和最终回复 | Pi 不保证 Codex 专属消息通道和折叠行为 |
| functions.exec、技能 orchestrator、Apps/Plugins 协议 → 实际 Pi 能力 | 不声明未实现的命名空间、工具或服务 |
| 修正上下文压缩、内联可视化的保证 | Pi 压缩不保证保留全部原始消息；终端不承诺内联交互图表 |
| 追加已有工具的准确协议 | 问题关联事件、三档权限、官方 session_id / max_output_tokens、JSON patch 参数、验证过期、代理线程与可选 LSP |
| 子代理跟进、消息、结果回传 → 本插件线程协议 | 使用 resume_agent、send_agent_message、wait_agents 和实际线程 ID |
| 审阅 JSON → review_comment | 当前工具接收 path、line、severity、comment；没有数字优先级字段或 Codex 审阅封套 |

代码审阅规范只在显式审阅或 reviewer 角色中提供，不是自动自我审查。没有接入公开模型目录中的 guardian、auto_review、browser/computer confirmation policy、持久任务平台或 token-budget 协议。

实际提示词在 [src/prompts](../src/prompts)。工具定义以运行时注册的 schema 为准，固定配置下保持稳定，界面刷新不重写它们。
