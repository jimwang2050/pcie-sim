# 发布闸门与回滚清单

应用版本：0.3.0；部署：GitHub Actions → GitHub Pages（`main` 分支，仅推送时部署）。

## 1. 发布前必须全绿

| 序号 | 闸门 | 命令 | 证明什么 |
| --- | --- | --- | --- |
| 1 | 模型/协议回归 | `npm test` | 116 项：TLP/配置/流控/事务/BERT/中断/回滚/schema |
| 2 | 静态站点自检 | `npm run check:site` | 入口与模块图完整、无绝对路径、无缺失文件、`.nojekyll` 存在 |
| 3 | 浏览器冒烟（三套） | `npm run test:browser` | 13 场景可选/单步/回退/复位/切视图、配置收敛、导引、筛选、URL；控制台无未捕获错误、无 4xx |
| 4 | 部署产物 | CI `deploy` job | 只发布 `index.html / css / js / .nojekyll / version.json` |

CI 顺序：`test`（含 `check:site`）→ `browser`（Chromium / Firefox / WebKit）→ `deploy`（仅 `main` push）。

## 2. 产物与身份

部署目录 `_site/`：

```
index.html
css/
js/
.nojekyll
version.json   # {"version","commit","run","builtAt"}
```

页面「说明」面板底部显示 `构建 v0.3.0 · <commit> · run <id>`，用于确认线上产物对应的提交。

## 3. 回滚

优先使用**不可变历史**，不要 force push / reset：

1. 打开 Actions → 找到上一次成功部署的 run（同 workflow）→ **Re-run all jobs**。
   该 run 会重新检出当时的提交并重新部署，线上回到该版本。
2. 若必须从代码回滚：`git revert <bad-commit>` 后推送 `main`，触发新的完整闸门与部署。
3. 部署失败不会覆盖当前线上版本：Pages 保留上一次成功的 deployment，直到新部署成功。
4. 回滚后在「说明」面板确认 `run <id>` 已对应到目标版本。

## 4. 发布记录（当前）

| 项 | 结果 |
| --- | --- |
| Node 回归 | 116/116 通过 |
| 静态站点自检 | 50 个文件、0 警告、0 错误 |
| Chromium 冒烟 | 18/18 通过 |
| WebKit 冒烟 | 18/18 通过 |
| Firefox 冒烟 | 本机 Playwright Firefox 无法启动（`Could not find profile folder`），由 CI（ubuntu-latest）验证 |
| 线上身份 | 部署后 `version.json` 含真实 commit 与 run id |

## 5. 已知限制

- 未做完整无障碍审计、390 px 窄屏验收与读屏测试。
- 未实现 SVG 导出、JSON 导入回放、URL seed。
- 事件规模上千时 `stepOnce` 的历史快照为 O(queue)，见 `docs/M3_DELIVERY.md` 的基准。
- 本项目是教学模型，任何数值都不能作为芯片实现或合规测试依据。
