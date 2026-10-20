# 侧边栏页脚身份区验收（2026-10-20）

## 改了什么

- 头像 26px → **20px**（`PersonalAvatar` 由 `AppSidebar` 传 `:size="20"`），与前排三个 28px 图标按钮同排时明显收小。
- 页脚左侧改成可伸展的胶囊按钮：`[头像] [昵称]`，右侧三个壳层动作保持原位（`.sidebar-footer-actions` 加 `flex: 0 0 auto`，不再被挤压）。
- 昵称是否出现由**实测几何**决定，不是断点：`apps/desktop/src/lib/profileNameFit.ts` 判断
  `padding + 按钮内边距×2 + 头像 + 名字与头像间距 + 昵称自然宽度 + 10px 余量 + 页脚 gap + 动作组宽度 ≤ 页脚宽度`。
  不满足就整条收起（**不做省略号截断**）——截断的名字在身份区读起来像故障。
- 测量源：一个 `visibility: hidden` 的 `max-content` 探针 span，复制昵称的真实排版宽度；`ResizeObserver` 盯页脚宽度，
  字体 ready 后重测一次（换字体会改变文字宽度，且不会触发 resize）。
- 折叠轨（`collapsed`）直接短路：那里只有一列图标，宽度测量会跟着动画抖动。
- 昵称仍在时 `title` 只写"个人"；昵称被收起时 `title`/`aria-label` 变成 `<昵称> · 个人`，窄侧栏下鼠标与读屏都还能拿到身份。

## 过渡：布局瞬时、透明度做运动

宽度参与动画就会切出半截字（实测中间帧在 `opacity 0.74` 时第二个字被垂直切掉）。因此：

- **淡入**：`max-width` 用 `0s` 直接到位，`opacity` 用 180ms `ease-out` 从 0 → 1。文字自始至终完整，只是由透明变不透明。
- **淡出**：`opacity` 180ms 从 1 → 0，`max-width`/`margin-left` 用 `0s linear 0.18s` 延迟到淡出结束后才收。
  淡出期间盒宽保持，所以看到的是完整名字在变暗，而不是被压扁。
- `--profile-name-max` 由 JS 写入实测自然宽度，淡入终点不会超过文字本身。
- `prefers-reduced-motion: reduce` 下取消过渡，两态瞬时切换。

真实时间轴（`timeline.json`，页内 rAF 采样，非 CDP 轮询）：

| 阶段 | 采样 |
| --- | --- |
| 淡入 | 7ms `w=24 op=0.15` → 73ms `w=24 op=0.64` → 173ms `w=24 op=1.00`；宽度全程满宽，无裁切 |
| 淡出（188 → 184px，跨阈值 2px） | `op 1.00 → 0.58 → 0.17` 期间 `width` 恒为 24；400ms 后 `width=0` |
| 淡出（300 → 184px，单帧大跳） | 盒宽被行宽直接压到 0（行已无空间），只能瞬切——拖拽不会这样跳 |
| 拖拽（300 → 150px，4px/帧） | 184px 起 `op 0.85`、176px `op 0.71 / w=22`；尾巴略有裁切，但已在淡出中 |

## 怎么验的

- 纯函数：`apps/desktop/src/lib/profileNameFit.test.ts`（6 例，含"差 1px 余量"与"未布局不上报"边界）。
- 组件：`AppSidebar.test.ts > AppSidebar footer identity`（happy-dom 无布局，用 stub 的 `clientWidth`/`getBoundingClientRect` 喂真实数字；
  注意 `getComputedStyle` 只对已挂到 document 的元素解析内联 padding/gap，所以必须 `attachTo: document.body`）。
- 真实 Chromium（本目录 `serve.mjs` + `drive.mjs`，CDP 驱动，非 Electron、无 Core/Gateway）：逐档改左栏宽度并读 DOM，
  `measurements.log` 为原始输出。

| 左栏宽度 | 昵称 | 昵称与动作组之间余量 |
| --- | --- | --- |
| 360 | 显示 | 193px |
| 320 | 显示 | 153px |
| 300 | 显示 | 133px |
| 280 | 显示 | 113px |
| 260 | 显示 | 93px |
| 240 | 显示 | 73px |
| 220 | 显示 | 53px |
| 200 | 显示 | 33px |
| 180 | 隐藏 | — |

两字昵称的阈值约 186px（`24 + 6 + 20 + 6 + 24 + 10 + 8 + 88`）；长昵称等比右移，不靠固定断点。
整页宽/窄两档见 `footer-wide.png` / `footer-narrow.png`，页脚特写见 `footer-crop-wide.png` / `footer-crop-narrow.png`（含折叠轨），
长昵称 + 悬停态见 `footer-long.png`；淡出中间帧见 `fade-step-1.png`（`opacity 0.58`，整字未切）。

## 边界

- 只测了 Chromium（Electron 渲染层同为 Chromium）。
- 行宽**瞬间**跳掉一大截（例如切换折叠）时，盒宽会被行宽直接压到 0，看不到淡出；那是拖拽不会产生的情形。
- 几何常量（20/3/6）在 `AppSidebar.vue` 与 `styles.css` 两处，改头像尺寸必须同时改。
