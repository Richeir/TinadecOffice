# 拖动把手：骑在缝上（2026-10-21，已实施）

## 问题

用户观察：左/右面板的把手 pill 整条都在面板内部，正常应该半内半外。核实后问题比视觉更严重——**一半命中区是死的**。

`.uie-column-resizer` 一直是 8px 宽、`right/left: -4px`，几何上确实跨缝；但 `.uie-column` 的 `overflow: hidden` 把探出去的一半裁掉，**被裁掉的区域不参与命中测试**。pill 又被 `::after { left: 1px }` 锚在内侧，于是空档里什么都没有、光标也不变。

这不是设计选择：同文件的垂直分割 `.uie-split-divider::after` 本来就是居中在分割线上（`translate(-50%, -50%)`），横向把手没跟着做，只因被 `overflow` 卡住。

## 改法（方案 A：pill 骑卡片边缘）

`apps/TinadecUI/src/components/UieColumn.vue`

| 改动 | 内容 |
| --- | --- |
| 裁切下沉 | `.uie-column` 改为 `overflow: visible`；新增 `.uie-column-clip`（`position:absolute; inset:0; overflow:hidden`）包住 rail / UieDock / stacks |
| 把手外置 | 把手从 clip 内移到列根下，作为 `.uie-column-clip` 的**兄弟**（`showResizer` 计算属性决定可见性：只左右列、折叠轨没有） |
| 命中区 | 8px → **12px**（`right/left: -6px`）：6px 在面板内、6px 在空档里 |
| 视觉 | pill 3×28，`left: 50%; transform: translate(-50%, -50%)` 骑在缝上；`is-resizing` 期间保持可见（拖到指针离开 12px 也不闪） |

连带改动：`apps/desktop/src/animations/page-transitions.css` 的 `overflow: visible !important` 从 `.uie-column` 改指 `.uie-column-clip`——页面进出场时 stack 要飞出面板，不能让新的裁切层把它切掉。

子元素（`UieStack`/`UieDock`/rail）都是 `position: absolute`，clip 与原列同 rect，**坐标零变化**。

## 实测（Chrome CDP，逐像素 `elementFromPoint`）

探针 `generated.html` 由 `build.mjs` 生成：`<style scoped>` 块从组件源码**原样抽出**（只剥离 scoped 属性选择器），DOM 结构与新模板一致（clip 在内、把手在外），不含手抄 CSS。

| 版本 | 面板右边线 dx 上的可命中范围 | 宽度 |
| --- | --- | --- |
| 改前（`overflow:hidden`） | −5 … −2 | 4px，**全在面板内** |
| 改后（clip 下沉） | **−6 … +5** | 12px，**6 内 + 6 外** |

改后 dx +6、+7 仍是空档（8px gap 里留 2px），dx ≥ +8 是相邻卡片。`columnOverflow: visible`、`clipOverflow: hidden` 与预期一致。

图：`before-pill-inside.png`（改前，pill 贴内侧）/ `after-pill-straddles.png`（改后，pill 跨过卡片描边）/ `after-dragging.png`（拖拽中，指针已在 60px 外仍在显示）。

## 回归

- `apps/desktop/src/components/UieColumnHandle.test.ts`（4 例）：把手是 clip 的**兄弟**（不是后代）、左列用 `-right` / 右列用 `-left`、中列无把手、折叠轨无把手。happy-dom 无布局，几何本身由上面的浏览器探针覆盖。
- `vue-tsc --noEmit` 通过；TinadecUI `vitest` 176/176；Desktop 的 `SpatialPage.test.ts`（真实挂 UIE 画布）与 `App.entry.test.ts` 通过。

## 边界

- 只测了 Chromium（Electron 渲染层同为 Chromium）。
- 拖拽改宽度仍走 `event.clientX` 基准，与把手位置无关，未改拖动逻辑。
- dock 内窗格之间的分隔线是列内部的分割，没有跨缝问题，本轮未动。
