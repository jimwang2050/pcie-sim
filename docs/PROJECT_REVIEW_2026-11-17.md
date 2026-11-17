# pcie-sim 项目审核与优化方案

审核日期：2026-11-17。代码基线：`0de9a3c`，审核开始时工作区干净。

> 规范复核补充（2026-11-17）：用户随后提供 PCIe 6.2 与 MindShare 3.0 本地资料。详细实施范围以 [待审核升级计划](UPGRADE_PLAN_2026-11-17.md) 为准。R06 应解释为“模式格式、承载和重传机制混用”，不能解释成“Flit 中禁止 InitFC/UpdateFC DLLP”；6.2 §3.4.1 明确列出 FM 的 InitFC。原工期为粗估，升级计划按更具体范围重新估算。当前仍未执行改造。

## 结论

项目适合继续发展成“可解释、可复现的 PCIe 教学实验台”。当前优势是零运行依赖、静态部署、13 个场景、分层时序与模型说明，且仿真核心可脱离 DOM 测试。优先投资应是协议准确性、回放可信度与场景约束，然后才是性能、教学体验和更多功能。

暂不建议整体迁移前端框架，也不建议立即扩展 CXL、SR-IOV 或复杂交换拓扑。已有功能覆盖较广，基础语义中的错误更容易损害使用者对整个工具的信任。

## 审核范围与证据

- `npm test`：50/50 通过，执行日志总时长约 410 ms；这不是浏览器性能数据。
- `node scripts/audit.mjs`：13 场景 × 6 代际 × 5 宽度，共 390 次运行，无异常、队列耗尽、事件时间单调且有限。此矩阵仅证明可执行性，不证明各组合受协议支持或最终状态正确。Gen6 专属场景会自行覆盖传入代际。
- 边界探针与完整结果见 [audit-results.json](audit-results.json)。它们报告当前缺陷，没有加入现有通过测试来掩盖问题。
- 已通过 HTTP 下载线上首页，其 SHA-256 与本地 `index.html` 一致：`85c27c5a06f8f3371250e69fc56904f4a69203ecf3bc6aa84396f6de9b808b9b`。只验证了首页文件，未验证全部线上 JS/CSS 或部署提交。
- 浏览器控制连续连接超时，未完成真实页面交互、布局、可访问性和性能实测；不能据此声称线上 UI 验收通过。
- 阅读了核心模型、场景、UI 编排与现有测试；参考了工作区内 cocotbext-pcie，并在线核对其上游源码及 PCI-SIG 公开资料。没有把现有测试自洽视作外部协议验证。

## 需要优先修复的问题

优先级：P1 为下一版本前应修复的语义或行为缺陷；P2 为随后处理的健壮性与维护问题。未发现足以定为 P0 的证据。

### R01 · P1：TLP 编解码共同采用了错误的请求头字段顺序

位置：`js/core/tlp.js:81`、`:98` 与 `decode()` 的配置/内存分支。

当前 Cfg 请求把目标 BDF/Register 放 DW1，把 Requester/Tag/BE 放 DW2；MRd/MWr 也把地址放在 Requester/Tag/BE 之前。参考实现的请求格式为 DW0 通用头 → DW1 Requester/Tag/BE → 后续地址或配置目标。构建与解析采用相同错误布局，因此内部往返测试仍会通过。

探针：Requester=`0x1234`、Tag=`0x56`、BDF=`0x0100`、Reg=`0x10`。当前 CfgRd 的内部 DWORD 为 `04000000 01000010 1234560F`；应为 `04000001 1234560F 01000010`。CfgRd 的 Length 也应是 1 DW，而不是因为“不带载荷”而写 0。

同组问题：多 DW 内存请求始终令 Last BE=0；32 DW 全字节读应使用 First/Last BE=`F/F`。`commonFields()` 中“无数据报文为 0”的说明不能用于 MRd/CfgRd，因为 Length 表示请求读取的数据量。

修复：区分逻辑 DWORD、显示字节序与外部序列化格式；按报文种类独立定义布局。黄金向量逐 DWORD 对比，不能只测试自身 encode/decode。不同工具的字节序应先统一再比对。

验收：CfgRd/Wr、3DW/4DW MRd/MWr、Cpl/CplD 独立向量通过；覆盖 1 DW、多 DW、1024 DW 特殊 Length 编码、BE 与非法边界。参考 [cocotbext-pcie TLP 源码](https://github.com/alexforencich/cocotbext-pcie/blob/master/cocotbext/pcie/core/tlp.py)，最终字段定义以有权访问的规范版本复核。

### R02 · P1：Completion Byte Count 错误

位置：`js/scenarios/mem_read.js:31`、`:35`；`js/scenarios/mem_write.js` 的读回 Completion。

128 B 请求拆成两个 64 B Completion 时，当前值为 64、0；Byte Count 应表示包含当前 Completion 在内仍需完成的字节数，即 128、64。0 编码代表 4096 B，不能用来表示“已经没有剩余字节”。最后一个 64 B Completion 也不应置 BCM 来表达拆包。

修复时同步改场景文案、详情与测试；增加“累计有效数据=请求字节数、Byte Count 递减、Lower Address 对应起始位置”的跨报文断言。

### R03 · P1：Gen6 CRC/FEC 的演示算法被当作协议事实展示

位置：`js/core/flit.js`、`js/scenarios/flit_gen6.js`、`js/main.js:308`、`js/ui/panels.js`、`js/core/event_info.js`。

256 B 的 236/6/8/6 B 分区与公开资料一致；但“8 B CRC=双份 CRC-32”不成立。实现实际写入 CRC-32 及其按位取反，两者不是独立保护。PCI-SIG 公开资料说明使用 64 位 CRC，并解释其基于 Reed–Solomon 的构造。FEC 也不能用统一“≤2 bit 可纠正”作为规范能力描述，纠错与分组和错误分布有关。

`checkFlit()` 完全依据外部 `bitErrors` 参数判定，不校验 `bytes`；翻转 Flit 字节后不传错误提示仍返回 OK。这可以作为故障演示桩，但应明确标为“预设故障结果”，不能让用户以为执行了真实纠错。

建议先准确改文案并增加模型保真度标识；真实 CRC/FEC 编码作为独立后续任务，依据规范与外部向量实现。不要只把函数改名为 CRC64 就认为完成。

来源：[PCI-SIG 对 CRC、FEC 和 Flit 分区的说明](https://pcisig.com/blog/evolution-pci-express-specification-its-sixth-generation-third-decade-and-still-going-strong?PageSpeed=noscript)。Flit 可用于低速率，不能简单禁止 Gen1–5 的 Flit 选项，应表达能力和协商条件：[PCI-SIG Flit Mode 说明](https://pcisig.com/what-flit-mode-and-why-did-pci-sig-move-unit-data-exchange)。

### R04 · P1：局部回退不能恢复闭包内的可变 Flit

位置：`js/core/sim.js:102` 的快照；`js/scenarios/flit_gen6.js:43` 起的 `flit0/flit1` 闭包与 `snapFlit()`。

快照保存调度器回调引用及模型状态，没有保存回调捕获的可变 Flit。复现：执行到 22 µs，记录 FEC 事件；继续到 40 µs 注入 2 bit 错误；后退至 22 µs 之前，再单步。原事件 `check.status=OK`，重放变成 `CORRECTED`，带入未来状态。完整退到起点重跑会重新初始化此对象，因此那种测试无法暴露问题。

修复：事件包不可变；把运行中可变对象纳入统一状态，或用显式事件描述符和纯 reducer 替代闭包。先做局部修复，不要求一次重写所有场景。

验收：对每个可回退步骤校验完整事件载荷和模型状态相等；尤其覆盖错误注入前后、重传、BAR 分配与内存修改。历史最多 200 步，需要在 UI 显示边界。

### R05 · P1：配置空间写宽度及 BAR 属性不准确

位置：`js/core/config.js:89`、`:107`。

`write(offset,value,size)` 忽略 size，普通路径总是 32 位写。写入 `0xAABBCCDD` 后调用 `write(4,2,2)`，Status 从 `0xAABB` 变成 0；16 位 Command 写不应覆盖它。模型也允许随意覆盖只读 ID，尚无统一 RO/RW/RW1C 语义。

BAR0 元数据声明 64 位，但寄存器初始值及探测结果低四位均未保留类型属性；显示 0 会被解释为 32 位 Memory BAR。64 位基址用 Number 拼接还存在超过安全整数范围的精度风险。

修复：按 size/byte enable 做掩码写，定义寄存器访问属性和 BAR 固定位；64 位地址使用 BigInt 或高低 DWORD。更新现有 BAR 预期值，增加未对齐和越界访问规则。

### R06 · P1：Gen6 事务场景混用 Non-Flit 链路流程

位置：`js/scenarios/mem_common.js:31` 与 `mem_read.js`、`mem_write.js`。

Gen6 配置使 `link.flitMode=true`，但场景仍调用明确标为 Non-Flit 的信用/DLLP 模型，生成独立 ACK、InitFC/UpdateFC 并直接传送 Non-Flit TLP。选择 Flit 的低代际事务场景又会被公共初始化中的 `mode:'auto'` 覆盖。用户选项、链路标签和实际事件语义可能不一致。

短期：建立场景能力表，对尚未实现的场景/模式组合说明原因并禁用，UI 展示实际生效配置。中期：分开 Non-Flit 与 Flit 的传输和保护策略，保留共享事务语义。Gen6 训练/Flit 专属场景继续保留。

验收：每个合法组合的事件机制与最终生效配置匹配；非法组合有明确提示，不静默替换。390 组可执行探针应升级为合法性矩阵。

### R07 · P2：流控只扣数，信用不足不阻止发送

位置：`js/core/fc.js:53` 与 `mem_common.js` 的发送回调。

1 个信用请求消耗 2 个时只是钳位为 0；`tlpPair()` 不检查结果就继续产生 TX/RX。当前固定脚本不会主动耗尽信用，因此测试未暴露问题。

修复：提供原子的 `canSend/tryConsume`，不足则进入阻塞队列；UpdateFC 后恢复。必须同时检查 Header/Data，避免部分扣减。先覆盖 VC0，不立即扩展多 VC。

验收：耗尽时没有 TX，信用非负，归还后只发送一次；展示“等待信用”的因果关系。

### R08 · P2：BERT 零样本即可 PASS，未实现所宣称的置信区间

位置：`js/core/bert.js:75`；README 的 BERT 描述。

`start(); lock();` 后 bits=0、ber=0、pass=true。模型没有置信区间计算。零错误不等于 BER 已达到目标。

修复：区分未测量、测量中、样本不足、通过、失败。若采用零错误单侧 95% 上界，使用 `-ln(0.05)/N`；达到 `1e-12` 约需 `3×10^12` bits。此处是统计验收方案，不是 PCIe 合规限值。README 应随实现同步。

### R09 · P2：调度器可令时间倒退

位置：`js/core/scheduler.js:19`。

执行到 100 ns 后 `at(10,fn)` 可令下一步时钟变成 10 ns；NaN/Infinity 也未校验。当前固定场景矩阵没有触发，但交互故障注入会扩大输入范围。

验收：拒绝非有限、早于当前时间和非法回调的输入，保持相同时间按入队序号稳定执行。允许当前时间事件，但应限制无限零延迟循环并明确报告 runToEnd 达到上限。

## 架构与性能判断

`main.js` 1587 行、`models.js` 2456 行、CSS 1490 行。按职责拆分已具有收益：场景注册/能力表、播放控制、弹窗管理、模型视图分别维护。保持 `core` 不依赖 DOM 的优势。

`renderAll()` 每步重绘所有面板，即使面板隐藏；流程视图开启时仍绘制隐藏的 timeline。`timeline.js:457` 整体替换 DOM，会带来重复构造、焦点或滚动状态维护成本。建议先跳过隐藏视图与未变面板，再用 requestAnimationFrame 合并渲染。此为源码可见的优化机会，尚未测得卡顿阈值。

快照每步复制内存、配置及队列，历史上限 200。调度器 splice/shift 为线性操作，但现有小脚本是否构成瓶颈尚无证据。先测 1k/10k 事件的调度、快照、DOM 渲染耗时及内存，再决定检查点+增量日志、可见窗口渲染或最小堆；不先引入 Worker 和复杂缓存。

时间语义应拆成协议时间、显示映射和播放节拍。当前训练压缩时间、真实包时长、固定教学间隔并存，不能把图上间距当作延迟或吞吐测量。另应核查多 Lane 有序集复制与 TLP 条带化的差异：当前 `orderedSetTimeNs()` 直接复用整链路字节率，不能用同一规则解释两种传输。

## 教学体验优化

以下是依据源码提出的方案，待浏览器验证：

1. 首屏给出“选择实验 → 本次目标 → 关键观察点”，隐藏 M1/M2/M3 等内部里程碑名；保留专家模式全量面板。
2. 给每个模型标明“字段准确 / 行为简化 / 预设演示”，详情中提供规范版本、来源和未建模项。
3. 将 RC/EP、TL/DLL/PHY、状态机、配置寄存器和错误原因联动；为事件增加稳定 ID、requestId、causeId，支持 Tag/BDF/层/错误筛选。
4. 增加阶段跳转、断点、当前历史边界、配置及事件 JSON 导出、URL 场景分享；先定版本化 schema，再考虑真实 trace 导入。
5. 弹窗已有 dialog 属性和 Escape 支持，继续补初始焦点、Tab 焦点约束、关闭后焦点恢复；窄屏改为视图切换并验证控件可达性。
6. 建立“生产者—消费者排序、信用耗尽、坏包重传、失效翻译、错误隔离恢复”等带问题与答案的实验。以因果关系替代单纯播放预排动画。

## 可借鉴项目与取舍

| 项目 | 借鉴内容 | 本项目落地方式 |
| --- | --- | --- |
| [cocotbext-pcie](https://github.com/alexforencich/cocotbext-pcie) | TLP 字段、事务合法性、RC/EP 与请求完成关系 | 开发阶段生成固定 golden vectors；不把 Python/RTL 环境加入浏览器运行依赖。先固定上游提交与许可证信息 |
| [QEMU PCI 模型](https://github.com/qemu/qemu/tree/master/hw/pci) | BAR、配置空间访问、MSI/MSI-X、AER 行为 | 选取小型寄存器行为用例，记录来源版本；不据其虚拟设备行为推导 PHY/LTSSM |
| [Warp Pipe](https://antmicro.github.io/warp-pipe/introduction.html) | 包化、路由、流控及 Wireshark 伴随工具 | 先统一事件和事务 schema；跨模拟器连接属于长期扩展，不能把自定义演示字节直接当真实抓包 |
| [WaveDrom](https://github.com/wavedrom/wavedrom) | 声明式 WaveJSON 到 SVG 的工作方式 | 借鉴“数据与渲染分离”，增加选中阶段的静态 SVG/时序导出；无需替换现有交互时序视图 |

这些是针对本项目的设计建议。现有 README 已列出前三项参考；真正缺少的是可执行的外部校验向量和来源追踪。复用源码前按各项目对应文件许可证核查，不能仅凭参考名称推断许可兼容。

## 实施顺序与验收

下列人日为一名熟悉项目开发者的初步估算，不含真实 CRC/FEC、完整规范合规工作与等待外部资料的时间。

| 阶段 | 内容 | 估算 | 完成条件 |
| --- | --- | --- | --- |
| A · 可信度修复 | R01–R06；Flit 先改准确文案和演示标识；增加外部向量及回退回归 | 6–10 人日 | 独立 TLP 向量通过；Completion 正确；局部回放一致；配置宽度正确；无混合模式事件 |
| B · 行为与工程保障 | R07–R09；拆分测试；场景能力表；GitHub Actions 跑测试后部署；浏览器冒烟 | 4–7 人日 | 信用阻塞/恢复、BERT 样本不足、调度非法输入均有回归；失败检查阻止部署 |
| C · 体验与性能 | 拆 UI 编排、隐藏视图跳过、按帧合并、事件筛选、URL 分享、JSON/SVG 导出 | 5–8 人日 | 13 场景浏览器冒烟通过；1440/1024/390 px 与明暗主题验收；导出重放一致 |
| D · 实验扩展 | 故障参数、断点、因果解释；按需求选择交换拓扑或真实 trace 适配 | 另行估算 | 每个新实验有学习目标、预期结果、来源与自动回归 |

依赖：A 的事件不可变与模式定义应先于 C 的导出/分享；schema 稳定后再做真实 trace 适配。B 的自动检查应在后续功能上线前启用。本地仓库未发现 `.github/workflows`，不能据此断定 GitHub 账户没有其他外部检查。

性能验收建议先记录固定浏览器、机器、数据集及基线，再以 1k 事件交互 p95 <50 ms、可见视图播放渲染 p95 <16.7 ms 为初始目标；这些是待测目标，当前没有达标证据。10k 事件用于暴露扩展瓶颈，不要求本轮一次性解决。

## 本次交付与边界

本次新增审核报告、只读复现脚本及结果文件。未更改运行代码、未提交 Git、未推送或重新部署。最优先的下一次实施范围为阶段 A，先把已有教学内容变得可信，再扩展功能。
