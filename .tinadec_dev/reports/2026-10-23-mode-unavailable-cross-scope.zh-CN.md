# “当前对话模式不可用”：模式版本跨存储作用域

日期：2026-10-23 · 范围：Desktop 输入框的模式选择 + 会话 `mode_version_id` 的绑定
证据：[`../evidence/2026-10-23-mode-scope-probe/verification.txt`](../evidence/2026-10-23-mode-scope-probe/verification.txt)（探针：`probe.mjs`，只读打开两个作用域的 SQLite）

## 症状

在项目会话里发消息，发送失败，界面提示“当前对话模式不可用，请在输入框左下角重新选择模式”。照做也没有用——重新选择之后仍然失败。

## 结论

**输入框的模式列表读的是 `user` 作用域，而会话跑在项目作用域。** 选择（或自动绑定）把这个 `user` 作用域的 ModeVersion id 写进了项目作用域的会话；Core 在建 run 前按**会话所在作用域**解析这个版本，找不到就以 `mode_unavailable` 拒绝。重新选择只是在同一份错误列表里再挑一个，所以永远修不好。

## 证据

项目 `RouterAPI` 的作用域库 `<project>/.tinadec/data/tinadec.db` 里，越晚创建的会话越是这样（`verification.txt`）：

| 会话 | 绑定版本 | 项目作用域可解析 | user 作用域可解析 |
|---|---|---|---|
| 29D1EF57（10-22 15:38） | `57B6ED44` | **MISSING** | published / `artex` |
| 9DEA7D36（10-22 15:23） | `25B954FC` | **MISSING** | published / `solo` |
| 79D18B87（10-22 15:22） | `1A72A895` | **MISSING** | published / `free_director` |
| 38F0A741（10-21 23:58） | `ABCEFBC7` | **MISSING** | published / `correction` |
| 19B852DC（10-19 15:02） | `547BF660` | published / `free_director` | published / `free_director` |

两个作用域各自 bootstrap 一套模式，**同一个模式在两边是不同的 id**（项目 `solo` = `FF4EEC56`，user `solo` v2 = `25B954FC`）。项目作用域 14 个已发布版本，user 作用域 27 个：`correction`、`artex` 只在 user 作用域存在。

## 代码路径

1. `ComposerCommandPanel.vue`：模式目录读两份——
   `Promise.allSettled([globalApi.listAgentModeTopologies(), baseApi.listAgentModeTopologies()])`，
   `globalApi = scopedApi(baseApi, () => 'user')`；
   而 `availableModes` 的取法是 `published(modes) ? modes : legacyModes`，即 **user 作用域优先**。
   `git log -S` 指向 `8c875aaa`（Correction mode, #60）引入这两处。
2. 同一文件 `watch([availableModes, modeVersionId, loading])`：会话没有模式时，把 `availableModes[0]` 自动写进会话——这个“第一个”来自 user 作用域，于是**新会话默认就会被绑到一个项目作用域解析不了的版本**。
3. `HomeController.settingsFor()`：发送时 `mode_version_id = session.mode_version_id`，原样带上。
4. Core `InteractionsEndpoints.cs:565-577`：roster 冻结抛 `InvalidDataException` → 409 `{ code: "mode_unavailable", message: "当前会话绑定的对话模式不可用，请在输入框左下角重新选择模式后重试。" }`。可操作的原文放在 `diagnostic`，前端只按 code 映射固定文案，所以用户看不到具体是哪个版本坏了。

## 修复

`ComposerCommandPanel.vue`：模式目录只读一次，走 `baseApi`（携带当前会话所在作用域的 `x-tinadec-storage-id`）；删掉 `globalApi`、`legacyModes` 与“user 优先”的取法；切换工作区时重新读取（`watch(selectedStorage)`），避免面板开着时拿着上一个作用域的列表。

回归：`ComposerBar.test.ts` 新增“reads the catalog once, from the conversation's own scope only”——读取次数 +1 即失败。

## 已经坏掉的会话怎么恢复

代码改动不会改已写入的 `mode_version_id`。受影响的会话打开后模式名附近会出现 ⚠；在模式菜单里重新选一次（现在列出的都是项目作用域能解析的版本，例如 `Solo` / `Team` / `Plan`），选择会写回会话，随后发送即可。

## 仍然没解决的问题（需要决定）

- **新装包的模式进不了已有项目**：`correction`、`artex` 只装在 user 作用域，`RouterAPI` 项目作用域里根本没有。修复后项目会话的模式列表里不会再看到它们——不是列表漏了，是那个作用域真的没有。要让已有项目用上新装模式，得让安装动作向已注册作用域分发（Core/Gateway 侧），或在建会话时允许显式跨作用域引用并让冻结逻辑认可（安全性要重新设计）。
- **Core 侧没有前置校验**：`createSession`/`updateSession` 接受任意 `mode_version_id` 并落库，问题推迟到发消息时才暴露。若在写入时校验“该版本必须属于本作用域且已发布”，这类脏绑定就进不了库。
- `components/ModeSelector.vue` 是**没有任何引用**的死代码，但里面是同一套“user 作用域优先”的写法；若将来接回来会重现同样的 bug。
