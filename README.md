# renx-code-v3

基于 `Node.js + TypeScript + pnpm workspace` 的多包项目模板，内置：

- `Oxlint`
- `Oxfmt`
- `Vitest`
- `Husky` `pre-commit`
- GitHub Actions `CI`

## 目录结构

```text
.
├── .github/workflows/ci.yml
├── .husky/pre-commit
├── packages
│   ├── app
│   ├── core
│   └── toolkit
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── vitest.config.ts
```

## 常用命令

```bash
pnpm install
pnpm run dev
pnpm run dev:watch
pnpm run dev:all
pnpm run format
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run demo
pnpm run ci
```

`pnpm run dev` 会直接运行 `@renx/app` 的 TypeScript 源码，不需要先 build。

`pnpm run dev:watch` 会监听源码变更并自动重跑。

`pnpm run dev:all` 会同时启动应用监听和 `Vitest` 监听，适合作为日常开发入口。

`pnpm run demo` 现在等同于一次快速 `dev` 运行。

## Git Hook

提交时会自动执行：

```bash
pnpm run ci
```

对应 hook 文件在 `.husky/pre-commit`。
