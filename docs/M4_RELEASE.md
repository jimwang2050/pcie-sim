# M4 发布验收交付

日期：2026-11-18；对应计划 WP11（完整回归、子路径/回滚验收）。应用版本升到 **0.3.0**。

## 改动

| 项 | 内容 |
| --- | --- |
| 静态站点自检 | 新增 `scripts/check-site.mjs`（`npm run check:site`）：从 `index.html` 追踪 CSS/入口模块，再递归解析 ES Module 相对引用，检查缺失文件、绝对路径、`.nojekyll`、是否误引用 `tests/docs/scripts`；支持 `--base` 做 HTTP 状态码与 MIME 校验 |
| 跨浏览器 | `playwright.config.js` 改为 Chromium / Firefox / WebKit 三个 project；本地可用 `PCIE_BROWSER_CHANNEL=chrome` 走系统 Chrome，`PCIE_BROWSER_PROJECT` 只跑单个浏览器 |
| CI 闸门 | `test` 增加 `check:site`；`browser` 安装并运行三套浏览器；`deploy` 仅 `main` push 且前两关通过后发布 |
| 产物身份 | 部署时生成 `_site/version.json`（version / commit / run / builtAt）；页面「说明」面板显示构建版本与提交 |
| 版本 | `package.json` 0.2.0 → **0.3.0**，新增根目录 `version.json` 占位（本地预览用） |
| 发布文档 | 新增 [发布闸门与回滚清单](RELEASE_CHECKLIST.md) |

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm test` | **116/116 通过**（新增 2 条：版本一致性、入口相对路径） |
| `npm run check:site` | **50 个文件，0 警告 0 错误** |
| Chromium 冒烟 | **18/18 通过** |
| WebKit 冒烟 | **18/18 通过** |
| Firefox 冒烟（本机） | 未能启动：Playwright Firefox 在 macOS 15.7.9 报 `Could not find profile folder`（手动带 `-profile` 启动同样失败，属本机浏览器构建问题） |
| Firefox 冒烟（CI） | **18/18 通过**（ubuntu-latest） |
| 三浏览器合计 | **54/54 通过**（run 44216030814，54 passed） |
| 部署产物 | `version.json` 为 `0.3.0 / c79cdee / run 44216030814`，线上可读 |
| `git diff --check` | 通过 |

CI 的 browser job 在 ubuntu-latest 上安装三套浏览器并全部通过（54 项）；本机 Firefox 的启动问题只影响本地复跑，不影响 CI 闸门。

## 版本与产物

- 版本：0.3.0
- 部署内容：`index.html`、`css/`、`js/`、`.nojekyll`、`version.json`
- 页面底部显示：`构建 v0.3.0 · <commit> · run <id>`

## 未完成 / 风险

- 无障碍审计与 390 px 窄屏未做；只验证 1440×1000。
- Firefox 仅能在 CI 验证，本机无法执行。
- SVG 导出、JSON 导入回放、URL seed 未实现（M3 遗留）。
- 事件规模上千时的历史快照开销已知但未优化（现有场景均在百级）。
- 回滚依赖 Actions 历史 run；若仓库清理历史 run，需要改用 `git revert`。
