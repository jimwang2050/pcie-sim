/**
 * 事件解读：为事件详情补充「物理意义 / 协议作用」。
 *
 * 两级信息：
 *  1. 事件类型（EVENT_INFO）：该类型在链路上的物理与协议含义；
 *  2. 所属层次（LAYER_INFO）：TL / DLL / PHY 各自负责什么，作为兜底解释。
 */

export const LAYER_INFO = {
  TL: {
    name: '事务层（TL）',
    physics: '事务层把软件请求封装为 TLP：地址/ID 路由、Tag 匹配、Completion 组装都在这里完成；本层事件代表一次“事务”的开始或结束。',
    role: '决定请求是否被正确投递与匹配，是协议语义层。',
  },
  DLL: {
    name: '数据链路层（DLL）',
    physics: '数据链路层为 TLP 加序列号与 LCRC，用 Ack/Nak 保证可靠传输；本层事件是链路级的可靠性动作（确认、重传、电源管理握手）。',
    role: '把不可靠的物理链路变成对事务层“无差错”的通道。',
  },
  PHY: {
    name: '物理层（PHY）',
    physics: '物理层负责串并转换、时钟恢复与差分电平驱动；本层事件反映电气与时序状态（锁定、均衡、空闲、环回、误码）。',
    role: '把数字符号变成可在通道上传输的信号，并稳定地还原回来。',
  },
  FLIT: {
    name: 'Flit 层（Gen6）',
    physics: 'Gen6 以 256B Flit 为固定传输单元，Flit 内打包多个 TLP/DLLP，并用 FEC + 8B CRC 保护；本层事件是 Flit 级组包、纠错与重传。',
    role: '替代 Non-Flit 的逐 TLP 保护，降低编码开销并提升纠错能力。',
  },
  STATE: {
    name: '状态 / 系统事件',
    physics: '状态事件表示 LTSSM 或模型状态发生迁移，通常由训练、低功耗握手、错误或热插拔触发。',
    role: '用于把链路与设备的宏观状态变化显式记录下来。',
  },
};

const ORDERED = {
  TS1: {
    name: 'TS1 有序集',
    physics: '训练序列 1 通过 16 个符号在 Lane 间并行传递链路号、Lane 号、支持速率位图、均衡与 Flit 能力等信息；接收端据此获得位锁与符号锁。',
    role: '链路训练的“探路包”：Detect / Polling / Configuration / Recovery 都靠它协商。',
  },
  TS2: {
    name: 'TS2 有序集',
    physics: '训练序列 2 表示本端已正确收到对端 TS1，双方进入确认阶段；TS2 同样携带速率与宽度信息。',
    role: '握手确认，避免单端误判训练完成。',
  },
  SKP: {
    name: 'SKP 有序集',
    physics: '跳过有序集按固定间隔插入，用来补偿收发两端参考时钟的 ppm 频差（弹性缓冲），同时维持块对齐。',
    role: '吸收时钟漂移，防止接收缓冲上溢/下溢。',
  },
  EIOS: {
    name: 'EIOS 电气空闲有序集',
    physics: '通知对端“本端即将停止发送”，随后差分对进入电气空闲（共模保持、无跳变）。',
    role: 'L0s / L1 / L2 进入前的收尾动作，让接收端安全地停止采样。',
  },
  FTS: {
    name: 'FTS 快速训练序列',
    physics: '从 L0s 退出时发送 N_FTS 个 FTS，让接收端在很短时间内重新获得位锁与符号锁，无需走完整 Recovery。',
    role: 'L0s 的低延迟退出手段。',
  },
  LOOPBACK: {
    name: 'Loopback 环回',
    physics: 'Loopback Master 让对端（或器件内部）把收到的符号原样回送；Internal 不经过通道，External 经整条通道往返。',
    role: '用于 SerDes / 通道的误码与完整性测试。',
  },
  PATTERN: {
    name: 'BERT 图案',
    physics: 'PRBS 由 LFSR 生成，周期 2^n−1；序列越短锁定越快、连 0/1 越短，越长越能覆盖低频成分与 AC 耦合效应。',
    role: '决定误码测试的频谱覆盖与锁定时间。',
  },
  BERT: {
    name: 'BERT 测量',
    physics: '发送端产生已知 PRBS，接收端用同一 LFSR 逐比特比较；BER = 错误数 / 累计比特，反映通道与器件的综合裕量。',
    role: '量化链路质量，判定 PASS / FAIL。',
  },
  BERTERR: {
    name: 'BERT 误码',
    physics: '比特判决错误通常由噪声、ISI、反射或时钟抖动造成；注入错误用于验证测试与恢复流程。',
    role: '暴露通道或器件问题，触发 FAIL 判定。',
  },
  REFCLK: {
    name: 'REF CLK 参考时钟',
    physics: '100 MHz 差分参考时钟为 PLL 提供基准；SSC 展频把能量分散以降低 EMI，但会带来频偏。',
    role: '所有高速串行链路的时钟源头。',
  },
  PLL: {
    name: 'PLL 锁相环',
    physics: 'PLL 把 REF CLK 倍频到链路速率；锁定过程中相位误差逐步收敛，未锁定前不能可靠收发。',
    role: '产生发送时钟与采样时钟。',
  },
  CDR: {
    name: 'CDR 时钟数据恢复',
    physics: 'CDR 从数据跳变中提取相位信息并锁定采样点；连续相同比特过长时依靠边沿预测维持相位。',
    role: '在没有独立时钟线的情况下恢复接收时钟。',
  },
  EQ: {
    name: 'Equalization 均衡',
    physics: 'TX FFE 预加重高频分量，RX CTLE/DFE 补偿通道插损与 ISI；收敛后眼图张开、BER 下降。',
    role: '对抗通道损耗，是高速链路能否工作的关键。',
  },
  COM: {
    name: 'COM 通道裕量',
    physics: 'COM 把噪声、串扰与 ISI 归一化后折算成剩余眼开度（dB），是规范定义的链路可用性判据。',
    role: '给出“这条通道 + 这套均衡是否够用”的量化结论。',
  },
  DETECT: {
    name: 'Detect 检测',
    physics: '发送端通过共模电压充放电观察远端终端电阻，判断对端是否存在接收器。',
    role: '链路训练的起点，决定是否继续训练。',
  },
  SPEED: {
    name: '速率变更',
    physics: '在 Recovery 中通过 TS 的 Speed Change 位协商目标速率，双方切换 PLL 分频后重新锁定。',
    role: '实现 Gen1 → Gen2 … Gen6 的逐级提速。',
  },
  MODE: {
    name: '模式协商',
    physics: '通过 TS 位协商是否进入 Flit 模式；Gen6 强制 Flit，低速率可选。',
    role: '决定链路层使用 Non-Flit 还是 256B Flit。',
  },
  DLLP: {
    name: 'DLLP 链路层报文',
    physics: 'DLLP 只在两端口之间传递链路级控制信息（Ack/Nak/PM），不经过事务层，也不被路由。',
    role: '维护链路可靠性与电源管理握手。',
  },
  ACK: {
    name: 'Ack 确认',
    physics: '接收端按序列号确认 TLP 已正确收到（LCRC 通过），发送端据此释放重传缓冲。',
    role: '可靠传输的正向反馈。',
  },
  NAK: {
    name: 'Nak 重传请求',
    physics: 'LCRC 错误或序列号不连续时，接收端请求从缺失处重传。',
    role: '可靠传输的纠错机制。',
  },
  MSG: {
    name: 'Message 消息 TLP',
    physics: '消息 TLP 以带内方式替代 PCI 的边带引脚，承载 PME、错误、热插拔等事件，无数据载荷。',
    role: '在链路内传递系统级事件。',
  },
  INT: {
    name: '中断',
    physics: '设备通过 MSI/MSI-X（内存写）或 INTx 消息通知软件。错误上报路径上，RC 收到 ERR_COR / ERR_NONFATAL / ERR_FATAL 这类 Message 后，会在内部把它转换为面向主机的中断（本模型记为 MSI Vector 0），再由中断控制器分发给 AER 处理程序。',
    role: '把硬件事件转交给软件处理。注意：错误路径上的这次中断由 RC 产生，不是 EP 发出的 MSI；EP 的 MSI 只用于设备自己的事件通知。',
  },
  MSI: {
    name: 'MSI 中断',
    physics: 'MSI 用一次内存写把向量号写到约定地址，由 RC 转成系统中断，避免共享物理引脚。',
    role: '现代 PCIe 设备的主流中断方式。',
  },
  'MSI-X': {
    name: 'MSI-X 中断',
    physics: 'MSI-X 用表项独立配置每个向量的地址与数据，支持更多向量与独立 mask。',
    role: '面向多队列设备的中断扩展。',
  },
  PM: {
    name: '电源管理事件',
    physics: 'CLKREQ#、Beacon、WAKE# 等边带信号或 L1 子状态变化，直接影响参考时钟与槽位电源。',
    role: '在低功耗与正常工作之间切换。',
  },
  PM_PME: {
    name: 'PM_PME 消息',
    physics: '设备唤醒后上报 PME 原因；它走正常 TLP 路径，需要链路已经可用。',
    role: '告诉软件“为什么醒”，而不是把链路拉起来。',
  },
  ERR_COR: {
    name: 'ERR_COR 可纠正错误',
    physics: '已被硬件纠正（如 LCRC 重传成功、FEC 纠正），对数据完整性无影响，仅记录。',
    role: '用于健康度统计与早期预警。',
  },
  ERR_NONFATAL: {
    name: 'ERR_NONFATAL 不可纠正非致命错误',
    physics: '数据已受影响但链路仍可继续工作（如 Unexpected Completion）。',
    role: '需要软件处理，但不必复位链路。',
  },
  ERR_FATAL: {
    name: 'ERR_FATAL 不可纠正致命错误',
    physics: '链路或设备状态不可信（如 Malformed TLP），继续传输可能污染系统。',
    role: '通常触发 DPC 隔离或链路复位。',
  },
  HOTRESET: {
    name: 'Hot Reset 带内复位',
    physics: '通过发送带 Hot Reset 位的 TS1 让下游端口复位，不依赖 PERST# 引脚。',
    role: '软件可控的链路级复位手段。',
  },
  DPC: {
    name: 'DPC 下游端口隔离',
    physics: '检测到不可纠正错误后，硬件把链路置为 Disable 并阻断下游 TLP，防止错误扩散。',
    role: '系统级 RAS：先隔离，再通知软件。',
  },
  ATS: {
    name: 'ATS 地址翻译',
    physics: '设备把虚拟地址（VA）交给 RC / IOMMU 翻译为物理地址（PA），并在 ATC 中缓存结果。',
    role: '降低 DMA 延迟，同时由 IOMMU 统一校验地址。',
  },
  ATC: {
    name: 'ATC 翻译缓存',
    physics: '设备侧缓存 VA→PA 的翻译结果；命中时直接以 AT=10b 访问，页表变化时必须失效。',
    role: '省掉到 IOMMU 的往返。',
  },
  TR: {
    name: 'Translation Request',
    physics: 'AT=01b 的 MRd 格式请求，只请求翻译、不访问内存。',
    role: 'ATS 快路径的入口。',
  },
  TC: {
    name: 'Translation Completion',
    physics: '返回 Translated=1 与 PA（或 UR / Invalid Request）；设备据此填充 ATC。',
    role: '完成一次地址翻译。',
  },
  INV: {
    name: 'Invalidate Request',
    physics: 'RC / IOMMU 在页表变化后要求设备清除 ATC 条目（单地址 / 范围 / 整表）。',
    role: '保证翻译缓存与页表一致。',
  },
  INVC: {
    name: 'Invalidate Completion',
    physics: '设备完成失效后回送确认，ITag 与请求匹配。',
    role: '告诉 RC 旧翻译不再被使用。',
  },
  PRQ: {
    name: 'Page Request 缺页请求',
    physics: '设备访问的页尚未映射，通过 PRI 上报缺页描述符与 PRG Index。',
    role: '让设备在缺页时不挂死。',
  },
  PRG: {
    name: 'PRG Response 缺页响应',
    physics: '映射建立后回送 Success，设备可重试翻译；失败则终止访问。',
    role: 'PRI 慢路径的收尾。',
  },
  MRd: {
    name: 'MRd 内存读请求',
    physics: 'Non-Posted 请求，必须由目标返回 Completion；Tag 用于把 CplD 与请求匹配。',
    role: 'CPU / 设备读取内存或 MMIO。',
  },
  MWr: {
    name: 'MWr 内存写请求',
    physics: 'Posted 请求，不要求 Completion；靠流控信用保证不丢包。',
    role: '高效写入内存或 MMIO。',
  },
  Cpl: {
    name: 'Completion 完成（无数据）',
    physics: '返回请求状态（SC / UR / CA / CRS），用于结束 Non-Posted 事务。',
    role: '状态回报，释放请求方缓冲。',
  },
  CplD: {
    name: 'Completion 完成（带数据）',
    physics: '携带读回数据与剩余字节数，可能被拆成多个 Completion。',
    role: '完成读事务并交付数据。',
  },
  CfgRd0: {
    name: 'CfgRd0 配置读（Type 0）',
    physics: '读取设备自身配置空间；由 RC 发起，经 Type 0 路由到目标 BDF。',
    role: '枚举与驱动初始化的基础。',
  },
  CfgWr0: {
    name: 'CfgWr0 配置写（Type 0）',
    physics: '写设备配置空间（如 Command、BAR、PMCSR）。',
    role: '配置设备并使其进入工作状态。',
  },
  ENUM: { name: '枚举步骤', physics: '软件读取 Vendor/Device ID、探测 BAR 大小并分配基址。', role: '让操作系统识别并驱动设备。' },
  FLIT: {
    name: '256B Flit',
    physics: '固定长度传输单元，内含多个 TLP/DLLP、DLP 与8B CRC，并使用三路交织 FEC 符号级纠错；本模型为布局及故障预设示意。',
    role: 'Gen6 的链路层传输与重传粒度。',
  },
  FEC: {
    name: 'FEC 前向纠错',
    physics: '在接收端直接纠正有限比特错误，避免重传带来的延迟。',
    role: '提升有效吞吐与链路鲁棒性。',
  },
  RETRY: {
    name: '重传',
    physics: 'CRC 失败或收到 Nak 时重放数据；重传单位在 Non-Flit 是 TLP，在 Flit 模式是 Flit。',
    role: '最终的数据完整性保障。',
  },
  DONE: { name: '阶段完成', physics: '场景流程走到一个可观察的完成点。', role: '便于对照前后状态。' },
  LTSSM: { name: 'LTSSM 状态迁移', physics: '链路训练状态机在 Detect / Polling / Configuration / L0 / Recovery / 低功耗之间迁移。', role: '决定链路当前能做什么。' },
};

/** 返回事件的解读信息；未知类型用层次说明兜底。 */
export function interpretEvent(ev) {
  const layer = LAYER_INFO[ev.layer] || LAYER_INFO.STATE;
  const t = ORDERED[ev.type];
  return {
    title: t ? t.name : `${ev.type} 事件`,
    layerName: layer.name,
    layerPhysics: layer.physics,
    physics: t ? t.physics : layer.physics,
    role: t ? t.role : layer.role,
    known: Boolean(t),
  };
}
