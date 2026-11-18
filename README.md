# PCIe 关键流程交互式模拟器（pcie-sim）

**在线演示：<https://jimwang2050.github.io/pcie-sim/>**

纯前端、零依赖的 PCIe 教学模拟器：用离散事件模型把链路训练、电源管理、TLP/DLLP 收发、错误与 RAS、PHY 均衡等流程拆成可单步、可回退、可观察的时间线，并在浏览器里用 SVG 实时绘制。

- 技术栈：原生 HTML + CSS + ES Module JavaScript，无构建步骤、无第三方库
- 运行方式：任意静态服务器（内置 `npm run serve`）
- 测试：Node 内置模型/协议回归 + Playwright 浏览器冒烟（开发依赖）

## PCIe 系统性能模型（P0–P1）

本地运行 `npm run serve` 后，从首页进入「性能实验室」。页面支持路径切换、参数扫描式试跑、逐节点资源明细和单笔事务时间线；右上角可切换深色 / 浅色，偏好与教学页共享。

RC Bridge 分成两层显示：AXI 物理峰值（`宽度/8 × 频率`，Gen6 ×16 为 1024 bit × 1 GHz = 128 GB/s）与桥接器有效上限（预设与链路带宽对齐，Gen6 ×16 为 128 GB/s）。Gen/Lane 变化会自动套用预设，三个参数仍可手动覆盖，有效上限超过物理峰值会被拒绝。

用 `node scripts/perf.mjs matrix --count 256` 运行纯读、纯写、读写混合的系统性能对照。可评估 EP DMA ↔ 主机 DDR、CPU/主机 DMA ↔ EP、同 Switch P2P，输出带宽、延迟、Tag、AXI 与逐跳 Credit 的等待。参数、JSON 导出和适用范围见[性能模型交付说明](docs/SYSTEM_PERFORMANCE_DELIVERY.md)。

## M0–M1：协议准确性

- NFM 请求头按协议 DWORD 顺序展示，修复 CfgRd Length、BE、Completion Byte Count；10 组独立头向量已与 cocotbext-pcie 编码器交叉核验。
- Type 0 配置子集支持 8/16/32 位访问、字节使能、RO/RW1C、BAR 固定类型位及独立高低 DWORD 探测；64 位地址无损表示。
- Flit 场景可局部回退重放；事件载荷不可变；界面显示最多 200 步的历史边界。
- 13 场景统一能力表：NFM 事务场景暂限 Gen1–5；低速 FM 仅在训练示意中开放。未实现组合明确拒绝，不静默覆盖用户配置。
- Gen6 Flit 仅是布局和显式故障结果示意；TLP/DLP 非标准 FM 编码，CRC/ECC 字节置零占位，不执行真实 CRC/FEC。
- 流控耗尽阻塞、BERT 统计判定与高级场景校准已在 M2 完成，见下节；完整真实 FM 编码属于可选 M5。

详见 [M0–M1 交付说明](docs/M0_M1_DELIVERY.md)。

## M2：行为校准

- **VC0 流控**：Header/Data 原子准入——任一信用不足则一条都不扣、不产生 TLP；归还封顶到通告上限，超额归还单独计数。「内存写」把 Data 信用降到 2（32B），可看到第 2 个 MWr 因 P_Data 耗尽而阻塞，UpdateFC 归还后只重发一次。
- **事务跟踪**：按 Requester+Tag 跟踪未完成请求，支持 Tag 冲突、Completion 分包累计（Byte Count 含本包）、无匹配 Tag 与超时；事务状态纳入快照，逐步回退不会丢状态。
- **BERT 判定**：不再以「零错误」直接判 PASS。未锁定 / 零样本 / 样本不足都不 PASS；零错误用单侧 95% 上界 `1−(1−0.95)^(1/n)`，非零错误用正态近似。Gen6（PAM4）按 FBER 1e-6 判定，Gen1–5 按 BER 1e-12——同样 1 Gb 零错误，Gen3 显示「样本不足」，Gen6 可以 PASS。
- **MSI-X**：Per-vector Pending + Function Mask；屏蔽期间触发只置 Pending，解除后补发，不再当作丢弃。
- **AER**：Mask 只抑制错误消息、不抑制错误计数；Severity 可把 Uncorrectable 错误改按 Fatal 上报，日志区分「检出级别 / 实际消息」。
- **DPC / RP PIO**：只有 Non-Posted 请求能合成 UR Completion；Posted 请求被丢弃且不生成 Completion。
- 测试增至 **108 项**（含 12 条 M2 行为用例），浏览器冒烟 15/15。

详见 [M2 交付说明](docs/M2_DELIVERY.md) 与 [规则登记](docs/M0_RULE_LEDGER.md)。

## M3：教学流程、schema 与导出

- **导引**：顶栏「导引」按当前场景给出学习目标、前置知识、关键观察点、结论、简化边界与依据；13 个场景全覆盖，缺导引会被测试拦住。
- **事件筛选**：时间轴支持按层（TL/DLL/PHY/STATE）、方向（TX/RX）、状态（正常/等待/错误）过滤，并显示「显示 x/y」，可一键清除。
- **场景命名**：顶栏场景名与副标题去掉了 M1–M5 等内部里程碑前缀。
- **弹窗可达性**：打开时焦点移入弹窗、关闭后归还，`Esc` 关闭，`Tab` 在弹窗内循环。
- **事件 schema**：事件新增 `modelTimeNs`、`fidelity`、`requestId`、`causeId`；导出事件另带 `schemaVersion` 与 `eventId`。
- **JSON 导出**：「事件日志」面板「导出」生成版本化轨迹（场景、请求/生效配置、时长、时间语义、全部事件），64 位地址以 `0x…` 字符串表示，不丢精度。
- **URL 状态**：`#scenario=…&gen=…&width=…&mode=…` 可直接恢复场景与配置，非法键忽略；配置收敛后回写 URL，不把轨迹塞进 URL。
- **性能基线**：`node scripts/bench.mjs` 测得 `emit` 约 1.1 µs/事件；含 200 步历史的 `step+emit` 约 50 µs/事件（现有场景均在百级事件内）。

详见 [M3 交付说明](docs/M3_DELIVERY.md)。

## M4：发布验收（v0.3.0）

- **静态站点自检**：`npm run check:site` 从入口递归解析 ES Module 引用，检查缺失文件、绝对路径、`.nojekyll` 与是否误引用测试/文档；加 `--base <URL>` 可校验线上状态码与 MIME。
- **跨浏览器冒烟**：Playwright 增加 Chromium / Firefox / WebKit 三个 project，CI 三套都跑；本地可用 `PCIE_BROWSER_CHANNEL=chrome` 走系统 Chrome，`PCIE_BROWSER_PROJECT=chromium` 只跑单套。
- **发布闸门**：`test`（含站点自检）→ `browser`（三浏览器）→ `deploy`（仅 main push），前一关失败不部署。
- **产物身份**：部署时生成 `version.json`（版本 / commit / run / 构建时间），页面「说明」面板底部显示，便于确认线上对应提交。
- **版本**：0.3.0。回归 116 项；Chromium / Firefox / WebKit 三套浏览器冒烟 **54/54**（CI）。本机 Playwright Firefox 构建无法启动，仅影响本地复跑。

发布闸门与回滚步骤见 [RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)，本轮结果见 [M4_RELEASE.md](docs/M4_RELEASE.md)。

## 快速开始

```bash
cd pcie-sim
npm run serve     # python3 -m http.server 8123
# 打开 http://localhost:8123

npm test          # 核心/协议/场景矩阵/回退测试，不依赖 npm install
npm run check:site    # 静态引用与模块图自检（发布闸门）
npm ci            # 仅开发浏览器回归需要
npm run test:browser  # Chromium / Firefox / WebKit；本地可用 PCIE_BROWSER_PROJECT=chromium
node scripts/bench.mjs # 模型吞吐基线（不含渲染）
```

也可以直接访问已发布的 GitHub Pages：<https://jimwang2050.github.io/pcie-sim/>（`main` 分支根目录，纯静态、无需构建）。

浏览器需支持 ES Module、SVG 与 SMIL（Chrome / Edge / Safari / Firefox 近期版本均可）。

## 界面与功能

- **顶栏**：场景、Gen（1–6）、Lane 宽度（x1–x16）、Flit / Non-Flit 模式、播放速度（-32× … 2×）、导引、典型模型菜单、深色 / 浅色主题
- **左列**：拓扑、链路参数、PHY 电气（眼图 / BERT）、LTSSM 状态机
- **中列**：分层时序（时序图 / 流程视图 + 层/方向/状态筛选）、事件详情
- **右列**：配置空间、训练计数器 / Flit 统计、电源管理、中断 / 错误、ATS / PRI、事件日志（可导出 JSON）、说明

「典型模型」弹窗按 **PHY 处理模型 / 链路模式 / 事务与排序 / 电源与系统 / 可靠性与可维护性** 五组，共 10 个模型（EQ、CDR、REF CLK/PLL、眼图与链路预算、BERT、Gen 对照、Flit 对照、Ordering、PM、RAS），详见下文「典型模型」。

### 场景

| 场景 | 内容 |
| --- | --- |
| 链路训练 | Detect → Polling → Configuration → L0，含 Gen6 Flit |
| LTSSM 电源管理 | L0s / L1.0–1.2 / L2 进入与唤醒（FTS、CLKREQ#、Beacon、WAKE#）+ 热插拔 |
| PHY 电气与均衡 | REF CLK / PLL、CDR 锁定、EQ 收敛、COM 与眼图 |
| Gen6 Flit 深入 | 256B 布局与预设故障/Flit 重放示意，未实现真实 CRC/FEC |
| Loopback / BERT | Internal / External 两套独立环回 + 多图案误码统计 |
| 设备枚举 | CfgRd0 / CfgWr0、BAR 探测与分配、Memory Enable |
| 内存读 / 写 | MRd → CplD、Posted MWr、VC0 信用原子准入、信用耗尽阻塞与 UpdateFC 归还、Tag 匹配 |
| MSI / MSI-X | 中断消息、向量、Per-vector Mask 与 Pending / 解除屏蔽补发 |
| AER | ERR_COR / ERR_NONFATAL / ERR_FATAL；Mask 只抑制消息、Severity 可重映射，以及 Hot Reset |
| DPC + RP PIO | 下游端口隔离、Egress Control、Non-Posted 的 UR Completion 与 Posted 丢弃 |
| ATS + PRI | 翻译请求、ATC 命中 / 失效、缺页与 PRG Response |
| PM D/P 状态 | D0–D3cold、P0–P2（PIPE PowerDown）、PMCSR 与 PME |

## 典型模型

顶栏「典型模型」菜单按「PHY 处理模型 / 链路模式 / 事务与排序 / 电源与系统 / 可靠性与可维护性」五组，每个模型都按「架构图 → 逐级运算 → 数学公式 → 动态演示 → 过程状态」组织，数值与左侧面板、当前场景共享同一套简化模型。

| 模型 | 讲什么 | 动态 / 交互 |
| --- | --- | --- |
| EQ 均衡 | TX FFE（c₋₁/c₀/c₁）→ 信道 ISI → RX CTLE → DFE → 采样判决；每级传递函数与当前抽头、COM、眼开度 | 点架构图任一级查看公式与数值；P0–P10 预设扫描、pre/post cursor 调整阶段高亮 |
| CDR 时钟恢复 | 相位检测 → 环路滤波 → VCO 的闭环；UNLOCKED / FREQ_LOCK / PHASE_LOCK / BIT_LOCK 四阶段的 ppm、相位误差与抖动惩罚 | 阶段框选对应环节，展示锁定过程与采样窗口 |
| REF CLK / PLL | 平台参考时钟（RP / EP 共用、SSC）、CLKREQ# 门控与上拉电阻、PLL 倍频产生最终 REF CLK；链路空闲的来源 | 横向信号链，展示门控开启 / 关闭时 PLL 与 REF CLK 的状态 |
| 眼图与链路预算 | NRZ / PAM4 眼图，叠加高斯白噪声（Box–Muller）与随机抖动模拟分析仪 persistence；Gen6 PAM4 三眼紧贴、电平轨线与轮廓 | 眼图随 Gen / 均衡 / 噪声参数变化重绘 |
| BERT 误码测试 | PRBS7/9/11/15/23/31 图案、Internal / External 两套独立环回、误码注入；按 95% 单侧上界与代际目标（Gen6 FBER / Gen1–5 BER）判定 | 切换图案与环回方式，实时统计误码率与判定结果 |
| Gen1–6 差异对照 | 2.5–64 GT/s、8b/10b / 128b/130b / PAM4 + Flit、FEC 与均衡要求 | 表格对照各代速率、编码、调制与关键机制 |
| Flit / Non-Flit | 256B Flit 打包、FEC + CRC、Flit 级重传 vs DLLP Ack/Nak 的差异 | 并排对照两种模式的字段与重传粒度 |
| 排序规则（Ordering） | PCIe 6.0 Table 2-42 四类事务的超越矩阵（默认 a / 例外 b）、RO / IDO、同 TxID Completion、死锁避免；Table J-1 九条规则及其系统需求 | 矩阵按行 / 列着色；「生产-消费者」24 秒慢放演示：RC（CPU / RAM dest / RP）↔ EP（EP / Status / Manager / RAM source），P_D 可多块在途，2 次 NP_S 轮询，CPL#1（flag=0）夹在 P_D1 / P_D2 之间且不超越 P_D，最后一次 CPL#2 返回 flag=1 |
| PM 电源管理 | 三层语义：D（软件写 PMCSR，可见）、L（D + ASPM 推导，通常不可见）、P（PIPE PowerDown 编码）；Table 5-1 的 L 状态 × 平台资源（主电源 / REF CLK / Vaux / 唤醒方式 / 退出延迟）；L0 / L0s / L0p / L1.0–1.2 / L2 / L3 定义与唤醒路径（FTS、CLKREQ#、Beacon、WAKE#） | 按当前场景高亮链路状态；表头与首列固定、长定义自动换行；机制浮窗给出 EP / D / L / 映射的逐项定义 |
| RAS 可靠性 | 检测（PHY / DL / TL / 链路状态）→ 分级（AER Severity / Mask 的 MUX）→ 上报（ERR_* Message → RC 转主机中断）→ 隔离（DPC / Egress Control 门控）→ 恢复（FLR / Hot Reset / 换卡）；AER / DPC / EDR / FLR / 热插拔的分工与可用性公式 | 硬件示意图区分设备内外，虚线表示软件 / ISR 路径；点分级、隔离、外部处理查看判定依据 |

「配置空间」面板的 **Header Layout** 另提供 Type 0（端点）与 Type 1（桥 / 根端口）两种 32-bit word 逐行布局：点击字段查看位域、DWC 寄存器名、访问属性与复位值，BAR / Expansion ROM BAR 还给出大小探测与位域表。

## 目录结构

```
pcie-sim/
├── index.html            # 页面骨架与面板布局
├── css/style.css         # 深 / 浅两套主题与全部组件样式
├── js/
│   ├── main.js           # UI 编排：场景、播放、弹窗、模型与事件联动
│   ├── core/             # 无 DOM 的仿真核心
│   │   ├── sim.js        # 离散事件调度、历史与快照
│   │   ├── link.js       # LTSSM 端口状态与链路参数
│   │   ├── packet.js     # 有序集 / TLP 速率与编码
│   │   ├── tlp.js dllp.js flit.js fc.js transactions.js
│   │   ├── phy.js        # REF CLK / PLL / CDR / EQ / COM 简化模型
│   │   ├── pm.js aer.js dpc.js ats.js hotplug.js msi.js
│   │   ├── config.js memory.js loopback.js bert.js
│   │   ├── event_info.js ltssm_info.js   # 事件 / 状态释义
│   │   ├── url_state.js trace_export.js  # URL 状态 / 版本化导出
│   │   └── playback.js   # 播放节拍
│   ├── scenarios/        # 每个场景的脚本化事件序列
│   └── ui/               # 渲染与视图
│       ├── timeline.js flowview.js topology.js
│       ├── panels.js models.js eye.js cfg_layout.js guide.js
├── scripts/              # 审计、参考向量比对、吞吐基准
└── tests/                # link / accuracy / scenarios / behavior / m3 五组回归
```

## 参考案例与来源

本项目是独立实现，**没有引入下列项目的源码或依赖**；它们只作为协议语义、字段布局与实现取舍的参考，用来校准“教学模型该保留什么、省掉什么”。下列参考目录（`qemu-master/`、`cocotbext-pcie-master/`、`warp-pipe-main/`）位于工作区中 `pcie-sim/` 的上一级，不属于本项目的运行产物。

### 1. QEMU（`qemu-master/`）

主要参考 `hw/pci/` 与 `hw/pci-bridge/` 下的设备模型：

- `hw/pci/pci.c`、`pci_bridge.c`：配置空间头、BAR、Command / Status、总线号与桥接窗口 → 对齐本项目的配置空间面板与枚举流程
- `hw/pci/pcie_aer.c`：AER 能力、Error Status / Mask / Severity、ERR_COR / ERR_NONFATAL / ERR_FATAL 消息与错误注入 → 对齐 AER 场景与 RAS 模型的“分级 / 上报”环节
- `hw/pci/msi.c`、`hw/pci/msix.c`：MSI / MSI-X Capability、向量表与 Mask → 对齐 MSI 场景
- `hw/pci/pcie_port.c`、`hw/pci-bridge/pcie_root_port.c`、`hw/pci/shpc.c`：根端口能力、Slot Capabilities、标准热插拔控制器 → 对齐热插拔与 Slot 面板
- 说明：QEMU 侧重设备虚拟化，**不建模 LTSSM / PHY 电气，也没有 DPC / RP PIO 实现**；因此 DPC、RP PIO、LTSSM、PHY 均衡等部分是按规范自建的简化模型

### 2. cocotbext-pcie（`cocotbext-pcie-master/`）

- `cocotbext/pcie/core/tlp.py`：TLP 的 Fmt / Type / TC / Attr / Length、地址与 Tag 字段，以及 CplD 的构造方式 → 对齐 TLP 构造与详情弹窗字段
- `cocotbext/pcie/core/dllp.py`：DLLP 类型（Ack / Nak / InitFC / UpdateFC / PM…）与信用类型 → 对齐 DLLP 事件与流控展示
- `cocotbext/pcie/core/caps/`（`pcie.py`、`aer.py`、`msi.py`、`pm.py`）与 `core/rc.py`、`device.py`、`switch.py`：能力结构与事件驱动的 RC / EP / Switch 模型 → 对齐枚举、路由与配置空间行为
- 差异：它面向 cocotb + RTL 协同仿真（Python），本项目是浏览器内的离散事件教学模型，不追求周期级时序

### 3. warp-pipe（`warp-pipe-main/`）

- `src/proto.c`、`inc/warppipe/proto.h`：TLP 的 3DW / 4DW、带数据 / 无数据封包格式
- `src/crc.c`、`inc/warppipe/crc.h`：链路层 CRC 校验思路 → 对齐 LCRC / 重传的教学表达
- `src/server.c`、`src/client.c`：跨模拟器链路与 MSI / 路由 / 流控的抽象
- 差异：warp-pipe 是用 C 写的 TCP 服务器，解决 Renode / QEMU 等分布式仿真之间的链路互联；本项目单页离线运行，不涉及网络传输

### 4. PCIe Base Specification 6.2

- LTSSM 状态、超时与 Recovery / L1 子状态流程 → 链路训练与电源管理场景
- §5.2 Table 5-1「链路电源状态与平台资源」→ PM 模型的 L 状态 × 平台资源表
- PHY 电气（发送均衡、CDR、COM）、Flit 模式（256B Flit、PAM4、FEC）→ PHY 场景与 Gen6 Flit 场景
- 电源管理三层语义：D 状态（软件写 PMCSR，可见）、L 状态（由 D + ASPM 推导，通常不可见）、P 状态（PIPE PowerDown 编码，由 PHY 实现，不等同于 L1 / L2）

### 5. DWC PCIe DBI 寄存器报告（`pcie_gen6_cxl/report/`）

- `DWC_pcie_dbi_cpcie_usp_ComponentRegisters.html`：`PF0_TYPE0_HDR` 的寄存器与字段（Vendor/Device ID、Status/Command、BAR、Capability Pointer…）
- `DWC_pcie_dbi_cpcie_dsp_ComponentRegisters.html`：`PF0_TYPE1_HDR` 的寄存器与字段（`TYPE1_STATUS_COMMAND_REG`、`SEC_LAT_TIMER_SUB_BUS_SEC_BUS_PRI_BUS_REG`、`MEM_LIMIT_MEM_BASE_REG`、`BRIDGE_CTRL_INT_PIN_INT_LINE_REG`…）
- 用于「配置空间 Header Layout」中 Type 0 / Type 1 的字段命名、位偏移、访问属性与复位值；Type 1 行显示的示例值取自这些报告的复位值

### 6. 通用方法

- 眼图：NRZ / PAM4 叠加 + 高斯白噪声（Box–Muller）+ 随机抖动，用于模拟协议分析仪的 persistence 效果
- BERT：PRBS7/9/11/15/23/31 图案与误码注入，BER 按置信区间估计
- RAS：AER / DPC / EDR / FLR / Hot Reset / 热插拔的分层处理模型（检测 → 分级 → 上报 → 隔离 → 恢复）

## 建模边界

- **时间压缩 1:100**：Detect 的 12 ms 规范计时在图上显示为 120 µs；播放速度可再放慢或加快
- 事件驱动而非周期级：关注“发生了什么、谁先谁后”，不模拟门级延迟、PLL 抖动波形与均衡器自适应算法细节
- PHY 采用简化传递函数与 COM 近似，不含真实 S 参数 / IBIS-AMI 模型
- 未建模：SR-IOV 细节、DOE、CXL 的 RAS 能力、完整热插拔电气时序、各厂商私有扩展
- P 状态按 PIPE PowerDown 语义（P0/P1/P2 编码），不表示 PCI-PM 性能档
- 时间轴、寄存器与计数均为教学用途的简化值，不能作为芯片实现或合规测试依据

## 测试

```bash
npm test
```

覆盖有序集编解码与传输时间、链路训练与变速、Gen6 Flit 布局 / 显式故障结果 / 重传示意、TLP 与配置空间 / BAR 枚举、VC0 信用原子准入与阻塞重发、Requester+Tag 事务匹配、内存读写、MSI / MSI-X（含 Pending 补发）、AER（Mask / Severity）、DPC + RP PIO（Posted 丢弃）、ATS + PRI、PM 状态机与 PMCSR、PHY 与均衡、Loopback / BERT 统计判定、单步回退、事件确定性，以及 PM 典型模型渲染片段的存在性断言。

另含 M3 回归：URL 状态解析与回写、13 场景导引完整性、事件筛选、版本化 JSON 导出（BigInt 无损）、事件 schema 字段。浏览器冒烟覆盖 13 场景 + 配置收敛 + 导引 + 事件筛选 + URL 恢复。

M4 另有静态站点自检（入口/模块图/绝对路径/`.nojekyll`）与版本一致性测试；浏览器冒烟在 CI 上跑 Chromium / Firefox / WebKit 三套。
