# 对话流五档密度（2026-10-22）

同一段**已落定的团队回合**（fixture `finished-team-run`：两个子智能体各自交回摘要、一张计划、一次失败的构建、一次重跑，12 个 flow row），按常规设置里那一个分段控件的五档各渲染一次。

- 运行：`node .tinadec_dev/evidence/2026-10-22-conversation-flow-shapes/qa.mjs`（需 `apps/desktop` 的 Vite dev server 在 `127.0.0.1:5173`；脚本自己拉起无头 Chrome，走 CDP 与 Debug Studio → 预览 → 对话消息流）。
- 读数：`checks.json`（每档的 `nodes`、折叠行、子智能体行文案、就地展开后的限高与 `overscroll-behavior`；以及分段控件每一段的文字与取色）。
- 截图：`settings-flow-options.jpg`（设置项）、`turn-<档位>.jpg`（整轮）、`turn-<档位>-detail.jpg`（就地展开）。

## 设置项

一个 `role="radiogroup"` 的分段控件，五段只写密度词：**极简 / 简洁 / 适中 / 详细 / 丰富**；下方只有一行描述，跟着选中的那段变。取色上未选中的四段同为 `rgb(164, 154, 177)`，选中的「丰富」为强调色 `rgb(210, 189, 245)` + 选中底色 `rgb(79, 62, 110)`。

## 读数摘要

| 档位 | 落定后行数 | 折叠 | 子智能体行 | 就地展开 |
|---|---|---|---|---|
| `minimal` 极简 | 0（只有一行摘要） | — | 无 | 无（行是 `div`） |
| `concise` 简洁 | 12 − 2 = 10 + “更早 2 步” | “更早 2 步” | 句柄 · 耗时 · 完成 · 任务行 | 无（行是 `div`） |
| `balanced` 适中 | 14 | 无 | 同 `concise` | 无 |
| `detailed` 详细 | 12 | 无 | 再加结果首行 `Found 4 callers` | 有，`max-height: 320px`，`overscroll-behavior-y: contain` |
| `rich` 丰富 | 12 | 无 | 同 `detailed` | 有，同 `detailed` |

`concise` 折掉的是**思考**与**等待**两行；子智能体行、计划、失败的构建（红色 `运行失败：npm run build`）都还在——这正是 `isBudgetRow` 的契约，`grouping.test.ts` 与 `ConversationActivity.test.ts` 同时钉住。

## 已知差异

- `rich` 的“正在跑的子智能体自动展开”在这一轮里看不到：fixture 的两个子智能体都已结束，落定卡片按设计从关闭态开始。所以 `detailed` 与 `rich` 在这一轮里的截图**逐像素相同**，两档的差别只有 `SubAgents.test.ts`（`parallel-sub-agents` 场景，行 `aria-expanded="true"`）能证明。
- 就地展开时，结果首行与展开体里的摘要首行重复一次（行内预览 + 正文报告）。按该档位的读法保留，未做去重。
