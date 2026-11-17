# M2 本地交付（现有行为校准）

日期：2026-11-18；对应计划 [UPGRADE_PLAN_2026-11-17](UPGRADE_PLAN_2026-11-17.md) 的 WP05 / WP07 / WP08。
应用版本仍为 0.2.0；本轮只校准既有场景的行为与判定，未新增发布流程。

## 范围与改动

| 工作包 | 改动 | 位置 |
| --- | --- | --- |
| WP05 流控 | VC0 Header/Data **原子准入**：任一信用不足则不扣任何一类、不产生 TLP；归还不得超过通告上限，超额归还单独计数；新增 `canSend/reserve/release`，旧 `consume/give` 保留为薄封装 | `js/core/fc.js` |
| WP05 事务 | 新增 Requester+Tag 跟踪：Tag 冲突、Completion 按 Byte Count（含本包）累计、无匹配 Tag、错误结束、超时；纳入快照/回退 | `js/core/transactions.js`、`js/core/sim.js` |
| WP05 场景 | 内存写只通告 2 个 Data 信用（32B）：第 2 个 MWr 因 P_Data 不足被阻塞，UpdateFC 归还后只重发一次；内存读/写回补 Tag 匹配事件，Ack 与事务完成分开 | `mem_write.js`、`mem_read.js`、`mem_common.js` |
| WP07 BERT | 判定不再等价于 `errors==0`：未锁定/零样本/样本不足都不 PASS；零错误用单侧 95% 上界 `1−(1−0.95)^(1/n)`，非零错误用正态近似；Gen6 用 PAM4 FBER 1e-6，Gen1–5 用 BER 1e-12 | `js/core/bert.js`、`loopback_bert.js`、`panels.js`、`main.js` |
| WP08 MSI | MSI-X Per-vector Pending + Function Mask：屏蔽期间触发只置 Pending，解除屏蔽后补发；MSI 无 Pending（保持丢弃） | `js/core/msi.js`、`msi_int.js` |
| WP08 AER | Mask 只抑制错误消息、不抑制错误计数；Severity 可把 Uncorrectable 错误改按 Fatal 上报；日志区分“检出级别/实际消息” | `js/core/aer.js`、`aer_error.js` |
| WP08 DPC | RP PIO 按请求类型处理：Non-Posted 读合成 UR Completion；Posted 请求**不生成** Completion，只记录丢弃 | `js/core/dpc.js`、`dpc_rpio.js` |
| WP08 ATS | 明确“被失效的 ATC 条目不能再命中”，补回归测试 | `js/core/ats.js`、`tests/behavior.test.js` |

## 验证

| 检查 | 结果 |
| --- | --- |
| Node 测试 | **108/108 通过**（新增 12 条 M2 行为用例） |
| 逐步回退重放 | 13 场景通过（事务状态已纳入快照） |
| 浏览器冒烟 | 15/15 通过，无页面异常/资源错误 |
| git diff 检查 | 通过 |

## 边界（未实现，避免过度宣称）

- 流控只建模 VC0 与“单次发送”策略；Dedicated/Shared InitFC、Scaled FC、多 VC 与真实信用回绕未实现。
- 事务跟踪只建模同一 VC、8 位 Tag；不做 PASID、Completion Timeout 计时器与重试策略。
- BERT 的 95% 上界与正态近似是教学统计方法，不作为电气合规判据；未实现真实 PRBS 发生器与眼图测量。
- AER 只建模 Mask/Severity 与消息开关，不实现完整 AER 寄存器组与消息路由；DPC 只记录行为，不模拟具体寄存器位。
- FM 事务（Gen6 TLP/DLP/CRC/FEC）仍属 M5。

## 复验

```sh
npm test
npm run test:browser
```
