/**
 * 场景导引：学习目标、前置、观察点、结论与简化边界。
 * 与场景实现保持同步；新增场景必须同时补一条，`missingGuideKeys` 用于测试。
 */
export const GUIDE_SECTIONS = [
  ['goal', '学习目标'],
  ['prereq', '前置知识'],
  ['observe', '关键观察点'],
  ['conclusion', '结论'],
  ['boundary', '简化边界'],
  ['source', '依据'],
];

export const SCENARIO_GUIDE = {
  link_training: {
    goal: '理解 LTSSM 从上电复位到 L0 的顺序，以及速率与 Lane 宽度是怎么谈定的。',
    prereq: ['TS1 / TS2 有序集的字段含义', 'Gen1–6 的速率与编码差异'],
    observe: [
      'Polling 阶段 Link/Lane 字段是 PAD，尚未分配',
      'Configuration 逐个 Lane 分配编号并确定宽度',
      'Recovery 里改速率，N_FTS 随速率变化',
    ],
    conclusion: '每个阶段只解决一个问题：位/符号锁 → 极性 → 速率 → Lane 宽度 → 均衡；全部完成后才进 L0。',
    boundary: '训练时序为教学压缩，未实现真实超时、误码率门限与电气参数。',
    source: ['PCIe 6.2 §4.2 LTSSM', '§4.2.4 Polling / Configuration'],
  },
  enumeration: {
    goal: '看清主机如何发现设备、读 ID、探测 BAR 并打开 Memory Space。',
    prereq: ['Type 0 配置空间头', 'BAR 大小探测（写全 1 回读）'],
    observe: [
      'Vendor/Device ID 是 RO，配置写不会改变',
      'BAR 低 DWORD 探测保留类型位，64 位 BAR 分两次探测',
      '先分配基址，再置 Command.Memory Space Enable',
    ],
    conclusion: '枚举是“读 ID → 分配地址空间 → 使能解码”的顺序，缺一步设备都不会响应内存访问。',
    boundary: '只实现 Type 0 的选定寄存器；Capability 链表与 Type 1 窗口未建模。',
    source: ['PCIe 6.2 §7.5.1', '配置空间 Header Layout（DWC DBI）'],
  },
  ltssm_pm: {
    goal: '区分 L0s / L1 / L2 的进入条件与唤醒路径。',
    prereq: ['ASPM 与 D 状态的关系', 'FTS / CLKREQ# / Beacon / WAKE# 的作用'],
    observe: [
      'L0s 用 FTS 快速退出，延迟最小',
      'L1 依赖 CLKREQ# 与 PLL 关断',
      'L2 需要 Vaux 与 Beacon 唤醒',
    ],
    conclusion: '越省电的状态退出代价越大；L 状态由 D 状态与 ASPM 推导，软件通常不可见。',
    boundary: 'P 状态只按 PIPE PowerDown 编码演示，不等同于 L1/L2；超时与电气时序简化。',
    source: ['PCIe 6.2 §5.2 Table 5-1', '§4.2.6 L1 / L2'],
  },
  phy_link: {
    goal: '理解 REF CLK/PLL → CDR → 均衡 → 采样判决的链路，以及 COM/眼图在其中的位置。',
    prereq: ['NRZ / PAM4 调制', 'FFE / CTLE / DFE 的作用'],
    observe: [
      'REF CLK 稳定后 PLL 才能锁定',
      'CDR 先频率锁定再相位锁定',
      'Gen3+ 才需要 Equalization，Gen6 是 PAM4 三眼',
    ],
    conclusion: 'PHY 不是“接上就能传”，每一级都可能成为裕量瓶颈；COM 是通道与均衡的综合结果。',
    boundary: '传递函数与 COM 为近似模型，不含 S 参数 / IBIS-AMI，也不模拟真实 EQ 收敛算法。',
    source: ['PCIe 6.2 §8 PHY Electrical', '典型模型：EQ / CDR / PLL / 眼图'],
  },
  flit_gen6: {
    goal: '认识 256B Flit 的分区与 Flit 级重传，理解它与 DLLP Ack/Nak 的差别。',
    prereq: ['Non-Flit 的 TLP + DLLP 结构', 'FEC / CRC 的分工'],
    observe: [
      'Flit 固定 256B，TLP 在 Flit 内打包并可跨 Flit',
      'CRC 与 FEC 字节在本模型中是占位，不参与真实运算',
      '重传以 Flit 为单位，而不是以 TLP 为单位',
    ],
    conclusion: 'Flit 把“保护 + 重传”的粒度从 TLP 提升到整块，代价是填充与缓冲。',
    boundary: '布局与故障结果为示意：未实现标准 FM TLP/DLP 编码与真实 CRC/FEC（M5）。',
    source: ['PCIe 6.2 §4.2.3.4', '附录 J/K（未纳入默认范围）'],
  },
  loopback_bert: {
    goal: '区分 Internal / External 两套环回，并学会用统计上界判断 BERT 结果。',
    prereq: ['PRBS 图案与锁定', 'BER / FBER 与置信区间'],
    observe: [
      'Internal 不经过通道，只能证明器件自身',
      '零错误不等于 PASS，要看样本量与置信上界',
      'Gen6 用 PAM4 FBER 目标，与低代际 BER 目标不同',
    ],
    conclusion: '“测了 1 Gb 没错误”只给出约 3e-9 的上界；要证明 1e-12 需要约 3 Tb 采样。',
    boundary: '统计判定为教学近似；图案元数据不等于真实 PRBS 发生器，也不做电气测量。',
    source: ['产品统计策略', 'PCIe 6.2 §4.2.3.4（FEC/CRC 背景）'],
  },
  mem_read: {
    goal: '看懂一次 MRd 如何被拆成多个 CplD，以及信用与 Tag 如何约束它。',
    prereq: ['Non-Posted 请求与 Completion', 'RCB 与 Byte Count 语义'],
    observe: [
      'Byte Count 是“含本包在内仍需完成”的字节数',
      '链路 Ack 只说明 DLL 收到，Completion 才结束事务',
      'Cpl 信用不足时 EP 不能发 Completion',
    ],
    conclusion: '读事务由 Requester+Tag 唯一标识，分包累计到 0 才算完成。',
    boundary: '只演示 RCB=64B 的指定案例，不覆盖所有拆分组合；未实现 Completion Timeout 计时器。',
    source: ['PCIe 6.2 §2.2.9 / §2.3.1', '本项目规则 TL-03 / TX-01'],
  },
  mem_write: {
    goal: '理解 Posted 写为什么没有 Completion，以及信用耗尽时发送端如何阻塞与重发。',
    prereq: ['Posted vs Non-Posted', 'P/NP/Cpl 六类信用'],
    observe: [
      'MWr 只消耗 P_Hdr/P_Data，不产生 Completion',
      'P_Data 不足时整条 TLP 被阻塞，Header 信用也不会被单独扣掉',
      'UpdateFC 归还后同一请求只重发一次',
    ],
    conclusion: '流控是“先准入再发送”：信用不足不产生 TLP，也不允许出现负信用。',
    boundary: '只有 VC0 与单次发送策略；Dedicated/Shared、Scaled FC 与多 VC 未实现。',
    source: ['PCIe 6.2 §2.7.2 / §3.3', '本项目规则 FC-01'],
  },
  msi_int: {
    goal: '区分 MSI 与 MSI-X 的寻址方式，并理解 Mask 与 Pending 的区别。',
    prereq: ['MSI Capability / MSI-X Table', '中断向量与 Per-vector Mask'],
    observe: [
      'MSI 用固定地址 + Data 携带向量号',
      'MSI-X 每个表项有独立地址 / 数据 / Mask / Pending',
      'Mask 期间触发只置 Pending，解除后补发',
    ],
    conclusion: 'Mask 是“延迟”，不是“丢弃”；Pending 位保证解除屏蔽后不丢中断。',
    boundary: '不实现向量范围校验、地址匹配细节与 MSI-X Table 的完整寄存器。',
    source: ['PCIe 6.2 §6.1.6 / §6.1.7', '本项目规则 MSI-01'],
  },
  aer_error: {
    goal: '分清“错误被检出”“错误消息发出”“主机中断”三件事。',
    prereq: ['Correctable / Uncorrectable', 'AER Status / Mask / Severity'],
    observe: [
      'Mask=1 时错误仍计数，只是不发 ERR_* 消息',
      'Severity 可以把 Non-Fatal 改按 Fatal 上报',
      '主机中断由 RC 产生，不是 EP 直接发的 MSI',
    ],
    conclusion: 'Mask 抑制的是上报路径，不是错误本身；Severity 决定系统如何反应。',
    boundary: '只建模选定寄存器的行为，不实现完整 AER 寄存器组与消息路由。',
    source: ['PCIe 6.2 §6.2', '本项目规则 AER-01'],
  },
  dpc_rpio: {
    goal: '理解 DPC 的隔离范围，以及 RP PIO 对不同请求类型的处理差异。',
    prereq: ['Downstream Port Containment', 'Posted / Non-Posted 的 Completion 语义'],
    observe: [
      'DPC 触发后 Egress Control 阻止下游 TLP',
      'Non-Posted 读可以由 RP PIO 合成 UR Completion',
      'Posted 请求没有 Completion，只能被丢弃并记录',
    ],
    conclusion: 'RP PIO 只能“补”本来应有 Completion 的请求；对 Posted 请求补 UR 是错误建模。',
    boundary: '不模拟具体 DPC 寄存器位；Egress Control 只做丢弃计数。',
    source: ['PCIe 6.2 §6.2.11', '本项目规则 DPC-01'],
  },
  ats: {
    goal: '理解 ATC 命中 / 未命中、失效与 PRI 缺页请求之间的关系。',
    prereq: ['地址翻译请求 / 响应', 'ATC 与 Invalidate'],
    observe: [
      '未命中才发 Translation Request',
      '被失效的条目不能再命中',
      'PRI 用于缺页时向主机请求页',
    ],
    conclusion: 'ATS 的正确性依赖“失效后不再命中”，否则会用到过期翻译。',
    boundary: '不做 PASID 与完整页表，只保留教学所需的计数与缓存条目。',
    source: ['PCIe 6.2 §10.2', '本项目规则 ATS-01'],
  },
  pm_dp: {
    goal: '把 D / L / P 三层状态分清楚，避免把 D3hot 直接当成 L2。',
    prereq: ['PMCSR 与 D 状态', 'PIPE PowerDown 编码'],
    observe: [
      'D 状态由软件写 PMCSR，可见',
      'L 状态由 D 状态与 ASPM 推导，通常不可见',
      'P 状态是 PHY 的 PowerDown 编码，不等同于 L1/L2',
    ],
    conclusion: 'D3hot 不等于 L3；L3 时链路已断电，不能再用 PMCSR 交互。',
    boundary: 'PM 流程为示意，未实现完整唤醒时序与平台电源资源变化。',
    source: ['PCIe 6.2 §5.2 / §7.5.3', 'PIPE PowerDown 编码'],
  },
};

export function guideFor(key) {
  return SCENARIO_GUIDE[key] || null;
}

/** 返回缺少导引的场景键，供回归测试使用。 */
export function missingGuideKeys(keys) {
  return keys.filter((key) => !SCENARIO_GUIDE[key]);
}
