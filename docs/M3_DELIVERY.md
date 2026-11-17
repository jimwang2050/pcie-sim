# M3 本地交付（教学流程、schema 与导出）

日期：2026-11-18；对应计划 [UPGRADE_PLAN_2026-11-17](UPGRADE_PLAN_2026-11-17.md) 的 WP09 / WP10 指定子集。
本轮只做教学编排、可访问性与导出的本地改造，未新增发布流程。

## 范围与改动

| 工作包 | 改动 | 位置 |
| --- | --- | --- |
| WP09 教学导引 | 13 个场景各有「学习目标 / 前置知识 / 关键观察点 / 结论 / 简化边界 / 依据」，顶栏「教学导引」按钮打开弹窗；新增场景若缺导引会被测试拦住 | `js/ui/guide.js`、`main.js`、`index.html` |
| WP09 场景命名 | 顶栏场景名与副标题移除 M1–M5 等内部里程碑前缀 | `index.html`、`main.js` |
| WP09 事件筛选 | 按层（TL/DLL/PHY/STATE）、方向（TX/RX）、状态（正常/等待/错误）过滤时间轴，显示「显示 x/y」，可一键清除 | `js/ui/timeline.js`、`main.js`、`index.html`、`css/style.css` |
| WP09 弹窗可达性 | 打开时记录焦点并移入弹窗，关闭后归还；`Esc` 关闭；`Tab` 在弹窗内循环，不落到被遮挡页面 | `js/main.js` |
| WP10 事件 schema | 事件新增 `modelTimeNs`、`fidelity`、`requestId`、`causeId`；导出事件带 `schemaVersion / eventId` | `js/core/sim.js`、`js/core/trace_export.js` |
| WP10 JSON 导出 | 「事件日志」面板「导出」生成版本化轨迹：场景、请求/生效配置、时长、时间语义、全部事件；BigInt 地址转 `0x…` 字符串 | `js/core/trace_export.js`、`main.js` |
| WP10 URL 状态 | `#scenario=&gen=&width=&mode=` 恢复场景与配置，非法键忽略；配置收敛后回写 URL，不写入轨迹 | `js/core/url_state.js`、`main.js` |
| WP10 性能基线 | 新增模型吞吐基准脚本，记录数量级 | `scripts/bench.mjs` |

## 验证

| 检查 | 结果 |
| --- | --- |
| Node 测试 | **114/114 通过**（新增 6 条 M3 用例：URL、导引完整性、筛选、导出、事件 schema） |
| 浏览器冒烟 | **18/18 通过**（新增教学导引、事件筛选、URL 恢复 3 条） |
| 13 场景逐步回退重放 | 通过 |
| `git diff --check` | 通过 |

模型基准（Node v23，仅核心事件循环，不含渲染）：

| 场景 | p50 | p95 | 单事件 |
| --- | --- | --- | --- |
| `emit` 10k（无调度/历史） | 11.0 ms | 18.5 ms | ≈1.1 µs |
| `step+emit` 2k（含 200 步历史） | 100.3 ms | 134.4 ms | ≈50 µs |

结论：现有场景事件数都在百级以内，当前开销可忽略。`stepOnce` 的历史快照会复制待执行队列（O(queue)），事件规模上到千级时按 50 µs/步增长；这属于已测量到的上限，尚未做增量快照或事件虚拟化。

## 边界（未实现）

- 未做完整无障碍审计（读屏、对比度）与 390 px 窄屏验收；只在 1440×1000 与 1024 宽度下人工检查。
- 未做 Firefox / WebKit 冒烟，仍只有本机 Chrome。
- 未实现 SVG 导出、JSON 导入回放、URL 中的 seed 与阶段参数。
- 事件虚拟化、增量快照与渲染合帧未做；基准只给出模型侧数量级。
- 导出不含 `sim` 快照与调度闭包，不能作为完整回放文件。

## 复验

```sh
npm test
npm run test:browser
node scripts/bench.mjs
```
