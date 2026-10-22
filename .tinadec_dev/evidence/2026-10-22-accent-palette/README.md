# 强调色兜底色板：青蓝 → 海报淡紫

## 问题

同一个界面里有两套品牌色：

| 来源 | 值 | 作用范围 |
| --- | --- | --- |
| `styles.css` 的 `:root[data-theme]` 兜底 | 青蓝 `#2ec4b6` / `#1f8f80` / `#1f6f68` | 任何没被 Monet 注入覆盖的变量 |
| `useTheme.ts` 的默认强调色 | 蓝 `#58a6ff` / `#0969da` | `buildDynamicVars` 输出的约 60 个变量 |

`lib/monetExtract.ts` 只重写那 60 个变量。`--text-link`、终端的选区色、分享卡的 canvas
取色、通知岛/详情弹窗/调试面板的 `var(--x, #2ec4b6)` 兜底、以及启动页的 fallback 都不在其中，
于是它们继续显示青蓝。直接后果：默认打开应用时局部青蓝、整体蓝，视觉上是两套配色；
更麻烦的是任何人（包括 AI）把这套源码当设计规范时，抄到的"品牌色"是青蓝。

## 现在的品牌色：海报淡紫

| 槽位 | dark | light |
| --- | --- | --- |
| `--accent-primary` / `--accent-brand` / `--text-brand` / `--text-link` | `#d2bdf5` | `#675687` |
| 主按钮底 / hover | `#746294` / `#8e7baf` | `#675687` / `#7d6aa0` |
| 选中底 / 描边 | `#4f3e6e` / `#d2bdf5` | `#ebdffa` / `#675687` |
| 页面底 | `#15121a` | `#ffffff` |

这两个值是 **Monet 的不动点**：把 `#d2bdf5` 送进 `buildDynamicVars(seed,'dark')` 得到
`tone80 = #d2bdf5`；`#675687` 送进 `'light'` 得到 `tone40 = #675687`。所以无论强调色注入
有没有跑，界面都是同一个颜色，不会出现"启动闪一下别的色"。

## 改动

- `apps/desktop/src/styles.css`：dark 与 light 两套 `:root` 块整体换成淡紫——强调/链接/按钮/
  选中/聚焦/边框，以及带蓝调的中性色（`#0a0e14`、`#11151c`、`#1a1f29` 这套海军蓝黑）改为
  紫黑 `#15121a` / `#1d1a22` / `#28242c`。成功/失败/警告/信息等语义色**保持不动**。
- `apps/desktop/src/composables/useTheme.ts`：`purple` 预设改为海报淡紫并成为
  `DEFAULT_ACCENT`；`dynamic`（跟随背景）在没有取色结果时回落该种子，而不是返回 `null`
  让整套变量停在 CSS 兜底值；带一次性迁移标记 `tinadec-accent-migrated-lilac`，
  把旧默认值 `blue` 换掉（用户主动选的其它颜色不受影响）。
- `apps/desktop/index.html`：早期主题脚本同步（首帧就是淡紫，不会先闪蓝），启动页底色
  改 `#15121a`。
- `apps/desktop/src/composables/useTerminal.ts`：终端选区色由 `--accent-primary` 派生
  （新增 `withAlpha()`，因为 xterm 不解析 `color-mix()`）；**ANSI 调色板的 blue 保持真蓝**，
  那是终端颜色语义，不是品牌。
- `apps/desktop/src/settings/sections/PersonalShareCard.vue`：`--accent` 是 shadcn 的
  `H S% L%` 三元组，canvas 画不出来，改读十六进制的 `--accent-primary`。
- `apps/desktop/src/lib/shareBrand.ts` + `apps/desktop/public/favicon.svg`：品牌标识
  从 `#2ec4b6` / `#18373b` 改为 `#d2bdf5` / `#241d33`。
- 所有组件兜底 `#58a6ff` → `#d2bdf5`；`var(--accent-success, …)` 的兜底单独是 `#3fb950`。
- 新增 `apps/desktop/src/styles.palette.test.ts`（6 例）：解析两套主题块，钉住强调色、
  要求与 `DEFAULT_ACCENT` 预设一致、并禁止八个已退役色值重新出现。

## 注意

- 终端的 ANSI `blue` / `magenta` 和 `--accent-info` 的真蓝不能跟着品牌走，它们表达的是
  "蓝"和"信息"，不是品牌。
- `shareBrand.ts` 头注释里的 "Regenerate with the same extraction…" 说的是 logo 路径几何体；
  颜色常量是独立一行，改色不影响 `shareCard.test.ts` 对 SVG 路径的一致性校验。

## 怎么复现这个对照

直接打开 `palette.html`。它加载同目录的 `styles.snapshot.css`（= 当前
`apps/desktop/src/styles.css` 的逐字快照），且页面不注入任何 Monet 变量——所以你看到的就是
"强调色注入没跑到"时应用的真实颜色。点按钮可切深浅两套。

## 验证

- `npx vue-tsc --noEmit` 通过
- `vitest`：`styles.palette` 6 例、`monetExtract` + `shareCard` + `AppearanceSection` 41 例、
  通知详情/MarkdownDiagram/useBackground/AppSidebar 回归全绿
- `vite build` 在本机被沙箱的批量删除守卫拦在清空 `dist/assets`（316 个文件 > 阈值 50），
  与本改动无关；样式表结构由调色板用例完整解析过
