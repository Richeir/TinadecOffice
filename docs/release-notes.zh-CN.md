# 发布说明与更新日志

发版不是打完 tag 就结束。Release 页是用户唯一会认真读的"这版变了什么"，而 `--generate-notes`
生成的是一串 PR 标题——`Fix/model center unify`、`Feat/flat conversation v2`——它们解释不了
任何事，也不回答"我为什么要升级"。

所以正文的主体由 AI 复盘后手写，机械部分（头图、安装表、平台边界、原始提交记录）交给模板和脚本。

## 谁写、什么时候写

发版前后由 AI 通读改动后写，人只审。两种时机都成立：

- **发版前**：把 `docs/releases/<tag>.md` 提交进仓库，CI 创建 release 时自动带上。
- **发版后**：直接 `--update` 补写，不需要重新发版。

## 写在哪

`docs/releases/<tag>.md`，文件名用带 `v` 的 tag（`v0.3.0.md`）。这个文件**就是 release 正文的主体**，
直接用 Markdown 写。不要写头图、安装表、平台边界——那些由 `.github/release-header.md` 与
`.github/release-footer.md` 提供，自动 changelog 也会自动折叠成「Full commit log」。

## 怎么取材

1. 提交范围：`git log --oneline <上一个 tag>..<当前 tag> --no-merges`
2. 改动规模：`git diff --shortstat <上一个 tag>..<当前 tag>`，用来判断这是小修还是大版本
3. PR 描述：`gh pr list --state merged --limit 50`，commit message 常被压缩，PR 正文里有动机
4. **关键改动读实现或报告**，别只看 commit 标题。标题说"统一下拉控件"，实际可能是修掉了三处交互缺陷
5. 数字只取可复验的来源：测试输出、性能报告、`AGENTS.md` 的实测记录。**不要估算，不要换算**

## 怎么写

固定两节：

```markdown
## What's new

**粗体小标题。** 一句话讲用户得到了什么。（3–6 条）

## What's changed

### 新能力
### 修复
### 性能
### 升级须知
```

写作规则：

- **写结果，不写实现**。"Core 作用域挂载 67.7 s → 2.37 s" 而不是 "把三处 N+1 收成单次查询"。
- **每条要能回答"我为什么要升级"**。答不上来的，删掉或并进上一条。
- **不要搬运 commit 原文**。`fix(core): check storage links from the scope root down` 要写成
  "存储符号链接检查改为只查作用域内部，否则 macOS 上每个作用域都会被拒"。
- **破坏性变化、需要用户操作的变化**，单独放进「升级须知」，不要藏在修复列表里。
- **数字必须对得上来源**。写不出处就写"未实测"，不要编。
- What's new 与 What's changed 允许部分重叠：前者是叙述（讲为什么），后者是清单（讲全不全）。

## 怎么发

```bash
# 只预览，不推送
node scripts/release-body.mjs v0.3.0 --out /tmp/body.md

# 生成并直接更新线上 release
node scripts/release-body.mjs v0.3.0 --update
```

`--update` 会重新拼装并 `gh release edit`，只改正文，不动 tag、不动资产。

## 交付前检查

- [ ] `docs/releases/<tag>.md` 存在（脚本缺它会给 `::warning::`，但不阻断发版）
- [ ] What's new 每一条都能回答"为什么升级"
- [ ] 每个数字都有来源
- [ ] 破坏性变化已写进「升级须知」
- [ ] 跑过 `--out` 预览，确认折叠块没有把正文吃掉、标题层级没有打架
