# 01. 与 DeepAgentsJS 的使用方式对齐分析

## 1. 分析目标

这份文档只看“怎么用”，不看内部架构是否完全一样。

目标是回答：

- `D:\work\deepagentsjs` 的真实主入口是什么？
- 开发者最常写的代码长什么样？
- 我们当前核心 SDK 的使用方式差异在哪里？
- 如果要求“使用方式对齐”，应该怎样改？

## 2. 参考源码

本分析主要参考：

- [agent.ts](/D:/work/deepagentsjs/libs/deepagents/src/agent.ts)
- [types.ts](/D:/work/deepagentsjs/libs/deepagents/src/types.ts)
- [local-sandbox.ts](/D:/work/deepagentsjs/examples/sandbox/local-sandbox.ts)
- [memory-agent.ts](/D:/work/deepagentsjs/examples/memory/memory-agent.ts)

这些文件足够说明 `deepagentsjs` 的顶层使用模型。

## 3. DeepAgentsJS 的真实主入口

`deepagentsjs` 的主入口是：

- `createDeepAgent(...)`

它不是若干入口并存，也不是优先要求开发者 subclass 某个基类。

这意味着对上层开发者而言，最重要的产品心智是：

- “我调用一个函数，得到一个可以直接 `invoke` / `stream` 的 agent”

而不是：

- “我先理解 runtime、resolver、memory service，再自己组装”

## 4. DeepAgentsJS 顶层参数形状

从 [agent.ts](/D:/work/deepagentsjs/libs/deepagents/src/agent.ts) 和 [types.ts](/D:/work/deepagentsjs/libs/deepagents/src/types.ts) 可以看到，`createDeepAgent(...)` 的顶层参数主要是：

- `model`
- `tools`
- `systemPrompt`
- `middleware`
- `subagents`
- `responseFormat`
- `contextSchema`
- `checkpointer`
- `store`
- `backend`
- `interruptOn`
- `name`
- `memory`
- `skills`

这组参数非常重要，因为它说明 `deepagentsjs` 的顶层 API 是按“开发者能理解的业务能力域”组织的，而不是按内部实现模块组织的。

## 5. DeepAgentsJS 的主调用姿势

### 5.1 创建

典型形态：

```ts
const agent = createDeepAgent({
  model,
  systemPrompt,
  tools,
  backend,
  subagents,
  memory,
  skills,
  interruptOn,
});
```

### 5.2 调用

典型形态：

```ts
const result = await agent.invoke({
  messages: [
    new HumanMessage("..."),
  ],
});
```

或者：

```ts
const stream = await agent.stream({
  messages: [
    new HumanMessage("..."),
  ],
});
```

这里最关键的使用习惯有两个：

1. 输入主路径是 `messages`
2. `invoke` / `stream` 风格与 LangChain/LangGraph 一致

## 6. backend 在 DeepAgentsJS 中是一等概念

这点非常关键。

在 `deepagentsjs` 里，`backend` 不只是一个内部技术点，而是开发者顶层直接配置的一等参数：

- 文件系统 backend
- state backend
- store backend
- composite backend
- sandbox backend

示例里也是直接这样用：

```ts
const agent = createDeepAgent({
  model,
  backend,
});
```

这意味着在 `deepagentsjs` 的产品心智中：

- backend 就是 agent 的运行环境

而不是：

- 先有 agent，再在外面拼一个 resolver，把工具导向某个 backend

## 7. memory / skills 在 DeepAgentsJS 中也是一等参数

示例 [memory-agent.ts](/D:/work/deepagentsjs/examples/memory/memory-agent.ts) 非常明确：

```ts
const agent = createDeepAgent({
  model,
  systemPrompt,
  backend,
  memory: [
    path.join(exampleDir, "AGENTS.md"),
  ],
});
```

这意味着：

- memory 不是“某个内部 subsystem 的实现细节”
- skills 也不是“先配 prompt，再配其他 service”

它们在顶层就是直接可配置的使用概念。

## 8. DeepAgentsJS 的默认产品哲学

`deepagentsjs` 在顶层 API 上体现出的产品哲学是：

1. 一个主入口
2. 参数名称贴近使用意图
3. 尽量不让开发者先理解内部组件
4. 环境能力通过 `backend` 暴露
5. 长程能力通过 `memory` / `skills` / `subagents` / `interruptOn` 暴露
6. 输入输出形式尽量贴近 LangChain agent 生态

这就是我们需要对齐的“使用方式”。

## 9. 当前 renx 核心层与它的使用差异

当前核心层已经有了一些很好的基础：

- `createAgent(...)`
- model binding
- formal toolset
- sandbox preset

但如果从“使用方式对齐”来看，仍然存在几处关键差异。

### 9.1 主入口命名差异

当前：

- `createAgent(...)`

DeepAgentsJS：

- `createDeepAgent(...)`

如果目标是对齐使用心智，最终主入口应该更接近 `createDeepAgent(...)`。

### 9.2 model 传入方式差异

当前核心层更偏：

- 先构造 `{ client, name }`

DeepAgentsJS 更偏：

- 直接传 `model`

如果要对齐使用方式，顶层应支持更直接的 `model` 输入，而不是默认要求先理解 binding。

### 9.3 backend 语义差异

当前核心层：

- 更偏 `preset` / `resolver` 装配

DeepAgentsJS：

- `backend` 是顶层一等参数

这说明下一步应该把 sandbox / filesystem / composite environment 收敛到 `backend` 语义，而不是让调用方优先记住 `preset`。

### 9.4 输入语义差异

当前核心层：

- 更自然的是 `inputText`

DeepAgentsJS：

- 更自然的是 `messages`

如果要和它对齐，顶层示例和默认主路径都应转向 `messages`。

### 9.5 memory / skills 的顶层使用差异

当前核心层：

- memory 仍更偏 subsystem / service 心智

DeepAgentsJS：

- 直接 `memory: string[]`
- 直接 `skills: string[]`

如果目标是使用方式对齐，这两个参数也要在顶层保持直接、朴素、可声明。

## 10. 对齐后的目标使用方式

如果完全按 `deepagentsjs` 风格对齐，核心层应支持这样的代码：

```ts
const agent = createDeepAgent({
  model: "gpt-5.4",
  systemPrompt: "You are an enterprise coding agent.",
  tools: [toolA, toolB],
  backend,
  memory: ["/memory/AGENTS.md"],
  skills: ["/skills/project"],
  subagents: [...],
  interruptOn: {
    Bash: true,
  },
});

const result = await agent.invoke({
  messages: [
    { role: "user", content: "分析这个项目并修改" },
  ],
});
```

这才叫“使用方式对齐”。

## 11. 具体改造建议

### 11.1 主入口

建议核心层最终提供：

- `createDeepAgent(...)`

可以保留内部实现复用现有 harness，但对外使用方式要对齐。

### 11.2 参数形状

顶层优先对齐到：

- `model`
- `tools`
- `systemPrompt`
- `middleware`
- `subagents`
- `responseFormat`
- `contextSchema`
- `checkpointer`
- `store`
- `backend`
- `interruptOn`
- `name`
- `memory`
- `skills`

### 11.3 backend 统一语义

把当前一些分散的：

- sandbox preset
- backend resolver
- local backend
- filesystem backend

收敛到统一的 `backend` 顶层参数心智。

### 11.4 调用方式

让核心层标准示例切换为：

- `invoke({ messages })`
- `stream({ messages })`

而不是优先展示 `inputText`。

### 11.5 toolset 的位置

当前我们做的 formal toolset 仍然是对的，但它更适合内部或扩展层。

对外如果想和 `deepagentsjs` 对齐，顶层仍应优先接受：

- `tools`

toolset 可以作为 helper，不应抢主入口心智。

## 12. 结论

如果你的要求是“与 `D:\work\deepagentsjs` 使用方式对齐”，那真正要对齐的不是底层 service 名称，而是下面这四件事：

1. 主入口：`createDeepAgent(...)`
2. 顶层参数：`backend / memory / skills / subagents / interruptOn` 这些一等参数
3. 调用方式：`invoke({ messages })`
4. 心智模型：上层先声明业务能力，而不是先理解内部装配

这也是下一阶段核心 SDK 应该继续推进的方向。
