# PCIe 关键流程交互式模拟器（pcie-sim）

纯前端、零依赖的 PCIe 教学模拟器：用离散事件模型把链路训练、电源管理、TLP/DLLP 收发、错误与 RAS、PHY 均衡等流程拆成可单步、可回退、可观察的时间线，并在浏览器里用 SVG 实时绘制。

- 技术栈：原生 HTML + CSS + ES Module JavaScript，无构建步骤、无第三方库
- 运行方式：任意静态服务器（内置 `npm run serve`）
- 测试：Node 内置测试运行器，50 项用例

## 快速开始

```bash
cd pcie-sim
npm run serve     # python3 -m http.server 8123
# 打开 http://localhost:8123

npm test          # node --test tests/*.test.js
```

浏览器需支持 ES Module、SVG 与 SMIL（Chrome / Edge / Safari / Firefox 近期版本均可）。

## 界面与功能

- **顶栏**：场景、Gen（1–6）、Lane 宽度（x1–x16）、Flit / Non-Flit 模式、播放速度（-32× … 2×）、深色 / 浅色主题、「典型模型」菜单
- **左列**：拓扑、链路参数、PHY 电气（眼图 / BERT）、LTSSM 状态机
- **中列**：分层时序（时序图 / 流程视图）、事件详情
- **右列**：配置空间、训练计数器 / Flit 统计、电源管理、中断 / 错误、ATS / PRI、事件日志、说明

「典型模型」弹窗包含：EQ 均衡、CDR 时钟恢复、REF CLK / PLL、眼图与链路预算、BERT、Gen1–6 差异对照、Flit / Non-Flit 差异、PCIe 排序规则（Table 2-42）、PM 电源管理（L/D/P 与唤醒）、RAS 可靠性（AER / DPC / EDR / FLR / 热插拔）。

### 场景

| 场景 | 内容 |
| --- | --- |
| 链路训练 | Detect → Polling → Configuration → L0，含 Gen6 Flit |
| LTSSM 电源管理 | L0s / L1.0–1.2 / L2 进入与唤醒（FTS、CLKREQ#、Beacon、WAKE#）+ 热插拔 |
| PHY 电气与均衡 | REF CLK / PLL、CDR 锁定、EQ 收敛、COM 与眼图 |
| Gen6 Flit 深入 | 256B Flit 打包、FEC/CRC、Flit 级重传 |
| Loopback / BERT | Internal / External 两套独立环回 + 多图案误码统计 |
| 设备枚举 | CfgRd0 / CfgWr0、BAR 探测与分配、Memory Enable |
| 内存读 / 写 | MRd → CplD、Posted MWr、信用与 UpdateFC |
| MSI / MSI-X | 中断消息、向量与 Mask |
| AER | ERR_COR / ERR_NONFATAL / ERR_FATAL 与 Hot Reset |
| DPC + RP PIO | 下游端口隔离、Egress Control、UR Completion |
| ATS + PRI | 翻译请求、ATC 命中 / 失效、缺页与 PRG Response |
| PM D/P 状态 | D0–D3cold、P0–P2（PIPE PowerDown）、PMCSR 与 PME |

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
│   │   ├── tlp.js dllp.js flit.js fc.js
│   │   ├── phy.js        # REF CLK / PLL / CDR / EQ / COM 简化模型
│   │   ├── pm.js aer.js dpc.js ats.js hotplug.js msi.js
│   │   ├── config.js memory.js loopback.js bert.js
│   │   ├── event_info.js ltssm_info.js   # 事件 / 状态释义
│   │   └── playback.js   # 播放节拍
│   ├── scenarios/        # 每个场景的脚本化事件序列
│   └── ui/               # 渲染与视图
│       ├── timeline.js flowview.js topology.js
│       ├── panels.js models.js eye.js cfg_layout.js
└── tests/link.test.js    # 50 项单元 / 集成测试
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

覆盖有序集编解码与传输时间、链路训练与变速、Gen6 Flit 打包 / FEC / 重传、TLP 与配置空间 / BAR 枚举、流控信用、内存读写、MSI / MSI-X、AER、DPC + RP PIO、ATS + PRI、PM 状态机与 PMCSR、PHY 与均衡、Loopback / BERT、单步回退、事件确定性，以及 PM 典型模型渲染片段的存在性断言。
