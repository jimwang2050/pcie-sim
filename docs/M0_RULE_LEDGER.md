# M0–M2 规则、代码与验证登记

资料版本及实际阅读文件 SHA-256 见 [M0_BASELINE.json](M0_BASELINE.json)。基线应用提交为 `0de9a3c`；原有 50 项测试通过。旧的 [audit-results.json](audit-results.json) 保留为改造前证据，新结果另存，未覆盖旧记录。

## 本轮规则子集

| ruleId | 规范/依据 | 实现位置 | 回归证据 | 支持边界 |
| --- | --- | --- | --- | --- |
| TL-01 | 6.2 §2.2.1.1、§2.2.7.1；MindShare Ch05 配置/内存格式 | `js/core/tlp.js` | `tests/fixtures/nfm-headers.json`；`accuracy.test.js` 的 10 个独立向量；`M1_REFERENCE_RESULTS.json` | NFM Cfg0/1、3DW/4DW MRd/MWr、Cpl/CplD；Tag 仅 8 位 |
| TL-02 | 6.2 §2.2.5.1、§2.2.2 | `buildCfg/buildMem/decode` | Length/BE/4KB/载荷/非法输入测试 | 单 DW、QW 对齐 2DW 例外、连续多 DW BE；不支持 Prefix/Digest |
| TL-03 | 6.2 §2.2.9.1、§2.3.1.1 | `tlp.js`、`mem_read.js`、`mem_write.js`、`enumeration.js` | Completion 累计字节、128→64、Lower Address；配置写完成事件 | RCB=64B 拆包是指定案例；完整事务跟踪在 M2 |
| CFG-01 | 6.2 §7.5.1.1.1–.4 | `config.js` | 访问宽度、BE、RO、RW1C、非法访问测试 | Command 支持所列控制位；Status 支持清除位；未实现能力只读，不表示完整配置空间 |
| CFG-02 | 6.2 §7.5.1.2.1 | `config.js`、`enumeration.js`、`cfg_layout.js` | BAR 固定位、独立高低探测、部分写、64 位地址 | Type 0 三个示例 BAR；Type 1 仅参考布局 |
| FM-01 | 6.2 §2.2.1.2、§4.2.3.4.1/.2 | `registry.js`、Flit 核心和面板 | 能力矩阵、Flit 模型标识测试 | FM TLP/DLP 仍是示意，未开放 FM 事务实验 |
| FM-03/04 | 6.2 §4.2.3.4.3/.4 | `flit.js`、`flit_gen6.js`、`panels.js`、事件说明 | 校验未实现标识、零占位、显式故障结果测试 | 不实现 CRC/FEC；不按 bit 数猜纠错能力；实际算法留 M5 |
| MODE-01 | 6.2 §3.4.1、§3.6.2.3；产品场景范围 | `registry.js`、13 个 builder、`main.js` | `scenarios.test.js` 的 1170 配置路径；浏览器自动收敛/恢复 | FM 可有 DLLP；依据承载/能力区分，不禁止 FM InitFC 概念 |
| SIM-01 | 项目回放契约 | `sim.js`、`flit_gen6.js` | 13 场景逐步完整状态比较；22→40µs 局部重放 | 只保证保留的最多 200 步；调度闭包不作为可导出格式 |
| SIM-02 | 项目时钟契约 | `scheduler.js`、`sim.js` | 过去/非有限时间、稳定顺序、零延迟循环上限 | 明确 `stopReason`；不声称覆盖所有协议超时 |
| FC-01 | 6.2 §2.7.2、§3.3；项目 VC0 子集 | `js/core/fc.js`、`mem_common.js`、`mem_read.js`、`mem_write.js` | 原子准入、归还上限、超额归还、阻塞且不产生 TLP | 只用 VC0 与 6 类信用（Data 16B）；Dedicated/Shared 发送策略、Scaled FC、多 VC 未实现 |
| TX-01 | 6.2 §2.2.9.1、§2.3.1.1 | `js/core/transactions.js`、`sim.js`、`mem_read.js`、`mem_write.js` | Tag 冲突、分包累计、无匹配 Tag、超时与快照回退 | 单 VC、8 位 Tag；不做 PASID、Completion Timeout 计时器 |
| BERT-01 | 产品统计策略（非合规门限） | `js/core/bert.js`、`loopback_bert.js`、`panels.js`、`main.js` | 零样本/未锁定/样本不足/置信上界/代际目标单测 | 零错误用单侧 95% 上界，非零错误用正态近似；Gen6 FBER 1e-6 与 Gen1–5 BER 1e-12 为教学取值 |
| MSI-01 | 6.2 §6.1.6、§6.1.7 概念子集 | `js/core/msi.js`、`msi_int.js` | Pending、解除屏蔽补发、Function Mask 测试 | MSI 无 Pending；不实现向量范围校验与地址匹配细节 |
| AER-01 | 6.2 §6.2 概念子集 | `js/core/aer.js`、`aer_error.js` | Mask 抑制消息但仍计数、Severity 重映射测试 | 不实现完整 AER 寄存器组与消息路由 |
| DPC-01 | 6.2 §6.2.11 概念子集 | `js/core/dpc.js`、`dpc_rpio.js` | Posted 不合成 Completion、读请求 UR Completion 测试 | 不模拟具体 DPC 寄存器位；Egress Control 只做丢弃计数 |
| ATS-01 | 6.2 §10.2 概念子集 | `js/core/ats.js` | 失效后条目不再命中的测试 | 不做 PASID 与完整页表 |

## 黄金向量生成与核验

向量预期 DWORD 为人工按字段表填写，没有从待测 JS 编码器导出。Node 回归分别验证构建结果与从独立 DWORD 解析的字段。额外使用本地 cocotbext-pcie 的纯编码模块对比头部，规范化其网络字节序到逻辑 DWORD；比较了 10 个头，不把参考工具的载荷字节序混入本项目表示。

复核命令：

```sh
python3 scripts/check-reference-vectors.py ../cocotbext-pcie-master
```

参考源码未复制进项目，脚本禁用字节码缓存以避免写入参考目录；参考 `tlp.py` hash 记录在结果文件。没有把该参考实现当成唯一规范来源。

## 暂留清单

| 项目 | 当前状态 | 后续范围 |
| --- | --- | --- |
| Header/Data 信用原子准入及耗尽阻塞 | 已实现 VC0 原子准入、阻塞与归还上限（M2 / FC-01） | 多 VC、Scaled FC、真实信用回绕 |
| BERT 零采样 PASS、置信区间 | 已实现判定门槛与 95% 单侧上界（M2 / BERT-01） | 真实 PRBS 发生器与电气测量不在范围 |
| MSI-X Pending、AER Mask/Severity、DPC 清除/Posted | Pending/补发、Mask/Severity、RP PIO Posted 已实现（M2） | 完整 AER 寄存器组、DPC 具体寄存器位仍未实现 |
| ATS/PRI 完整性 | 失效后不再命中已有测试（M2 / ATS-01） | PASID、完整页表与 PRI 流控未实现 |
| PHY/训练真实时序、OS/PIPE 精细模型 | 保留教学简化 | 完整电气模型不在默认范围 |
| FM TLP/DLP、跨 Flit、真实 CRC/FEC | 尚未实现，字节与校验有示意标识 | 可选 M5 / WP12，需附录 J/K 等前置 |
| Firefox/WebKit、窄屏完整验收、发布闸门/回滚 | 仅本机 Chrome 冒烟与最小 CI | M3–M4 |

这份清单与当前探针能观察到的问题一致；M2 完成项按 WP05/WP07/WP08 的实际实现登记，未授权的后续升级仍标为未实现。
