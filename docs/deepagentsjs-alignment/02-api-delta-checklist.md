# 02. API 对齐差异清单

## 1. 主入口

DeepAgentsJS：

- `createDeepAgent(...)`

当前 renx：

- `createAgent(...)`

建议：

- 对外主入口收敛到 `createDeepAgent(...)`

## 2. model

DeepAgentsJS：

- 顶层直接传 `model`

当前 renx：

- 顶层更鼓励 `ModelBinding`

建议：

- 顶层支持直接 `model`
- binding 保留为底层 helper

## 3. backend

DeepAgentsJS：

- `backend` 是一等参数

当前 renx：

- 更偏 `preset` / `resolver`

建议：

- 顶层一等暴露 `backend`

## 4. memory

DeepAgentsJS：

- `memory: string[]`

当前 renx：

- 更偏 memory subsystem 心智

建议：

- 顶层增加直接 `memory` 数组语义

## 5. skills

DeepAgentsJS：

- `skills: string[]`

当前 renx：

- 还未作为顶层直接主路径

建议：

- 顶层增加直接 `skills` 数组语义

## 6. input

DeepAgentsJS：

- `invoke({ messages })`

当前 renx：

- 更偏 `inputText`

建议：

- 标准示例主路径切到 `messages`

## 7. tools

DeepAgentsJS：

- 直接 `tools`

当前 renx：

- `toolsets` + `tools`

建议：

- 顶层仍应优先支持 `tools`
- `toolsets` 作为 helper

## 8. interrupt

DeepAgentsJS：

- `interruptOn`

当前 renx：

- approval / policy / interrupt 还比较底层

建议：

- 增加顶层 `interruptOn`

## 9. subagents

DeepAgentsJS：

- `subagents`

当前 renx：

- collaboration / child run primitives 存在，但顶层不够直接

建议：

- 顶层直接 `subagents`

## 10. 最终目标

目标不是把代码结构改成和 `deepagentsjs` 一样，而是让开发者最终能写出与它近似的代码：

```ts
const agent = createDeepAgent({
  model,
  systemPrompt,
  tools,
  backend,
  memory,
  skills,
  subagents,
  interruptOn,
});

const result = await agent.invoke({
  messages: [
    { role: "user", content: "..." },
  ],
});
```
