# DeepAgentsJS Alignment

这组文档专门回答一个问题：

- `D:\work\deepagentsjs` 的上层使用方式是什么？
- 当前 `D:\work\renx-code-v3` 核心 SDK 与它相比，使用方式差在哪里？
- 如果目标是“使用方式对齐”，核心层应该怎样改，而不是只做到能力类似？

## 阅读顺序

1. [01-usage-alignment.md](./01-usage-alignment.md)
2. [02-api-delta-checklist.md](./02-api-delta-checklist.md)

## 结论先看

如果目标是与 `deepagentsjs` 真正对齐，接下来核心 SDK 应该收敛到：

- 主入口以 `createDeepAgent(...)` 为中心
- 顶层一等参数围绕 `model / tools / systemPrompt / middleware / subagents / backend / memory / skills / interruptOn`
- 主调用输入以 `messages` 为中心
- `backend` 是一等环境语义，而不是让上层先理解 `preset` / `resolver`
- `invoke` / `stream` 使用方式尽量贴近 `deepagentsjs`

也就是说，下一阶段的重点不应该只是“继续补能力”，而是把顶层 API 和调用姿势收敛到与 `deepagentsjs` 一致的心智模型。
