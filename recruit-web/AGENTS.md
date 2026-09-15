# recruit-web AGENTS.md

前端（Vue 3 + Vite + TypeScript）AI 协作约定。

## 硬性规则

- 禁止 `any` 类型（使用具体类型或 `unknown`）。
- API 数据必须用 Zod schema 验证。
- HTTP 请求用 `httpClient`（禁止直接 import axios / ky / fetch）。
- 组件文件不超过 400 行（超过则拆分）。
- 禁止 `console.log`（用 `console.warn` / `console.error`）。
- 类型定义放 `src/types/*.types.ts`（Zod schema → infer）。
- API 函数放 `src/lib/api/*.api.ts`（queryOptions 模式）。
- 样式用 Tailwind + `cn()`，禁止 inline style（豁免：`*-print-dialog.vue` 打印组件允许 inline style；设计稿还原页允许独立 CSS 文件直搬原型，如 `src/pages/login/login.css`）。
- 使用路径别名 `@/` 进行内部导入。
- 环境变量必须以 `VITE_` 前缀开头。
