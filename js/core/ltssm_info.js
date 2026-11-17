/**
 * LTSSM 各顶层状态的定义、进入/退出条件与物理意义。
 * 依据：MindShare PCIe 3.0 Ch14/Ch16、PCIe 6.2 规范第 4/5 章。
 */
export const LTSSM_INFO = [
  {
    key: 'Detect',
    cn: '检测',
    definition: '复位后的初始状态。发送端处于电气空闲，通过检测链路远端的 50Ω 终端判断对端接收器是否存在。',
    entry: [
      'Fundamental Reset（Cold / Warm）释放',
      'Hot Reset 完成',
      'Polling / Configuration / Recovery 失败或超时后回退',
      '从 L2/L3 唤醒后重新开始训练',
    ],
    exit: [
      '检测到远端接收器 → Polling.Active',
      '未检测到接收器 → Detect.Quiet 继续等待',
      '测试设备条件 → Polling.Compliance',
    ],
    physical: '用差分对上的终端阻抗与共模电平判断对端是否上电并连接；此时不发送有效数据，链路尚未建立位锁。',
    substates: ['Detect.Quiet', 'Detect.Active'],
  },
  {
    key: 'Polling',
    cn: '轮询',
    definition: '双方以 2.5 GT/s 发送 TS1/TS2 有序集，建立位锁与符号/块锁，修正 Lane 极性并获知双方支持的数据速率。',
    entry: ['Detect 检测到远端接收器'],
    exit: [
      '收到足够的 TS1/TS2 并完成锁定 → Configuration',
      '24 ms 超时且未收到有效 TS → 返回 Detect',
      '测试条件 → Polling.Compliance',
    ],
    physical: '接收端 CDR 锁定发送端时钟，8b/10b 符号对齐或 128b/130b 块对齐；必要时翻转差分极性以修正 Lane 反接。',
    substates: ['Polling.Active', 'Polling.Configuration', 'Polling.Compliance'],
  },
  {
    key: 'Configuration',
    cn: '配置',
    definition: '协商链路宽度、Lane Number 与 Link Number，完成 Lane 去偏与通道映射，确定 Flit / Non-Flit 数据流模式并置 LinkUp。',
    entry: ['Polling.Configuration 成功'],
    exit: [
      'Configuration.Idle 完成 → L0',
      '宽度/编号协商失败 → 返回 Detect',
      '软件指定 → Disable 或 Loopback',
    ],
    physical: '每条 Lane 获得独立编号并完成去偏；确认哪些 Lane 属于同一链路；Flit Mode 在此阶段根据双方能力确定。',
    substates: [
      'Configuration.Linkwidth.Start',
      'Configuration.Linkwidth.Accept',
      'Configuration.Lanenum.Wait',
      'Configuration.Lanenum.Accept',
      'Configuration.Complete',
      'Configuration.Idle',
    ],
  },
  {
    key: 'L0',
    cn: '正常工作',
    definition: '链路正常工作状态，TLP、DLLP 与有序集在链路上传输。',
    entry: ['Configuration 完成', 'Recovery 完成', '从 L0s / L1 唤醒并完成恢复'],
    exit: [
      '空闲且 ASPM 使能 → L0s',
      'PM 或软件请求 → L1 / L2',
      '变速、变宽或检测到错误 → Recovery',
      '软件请求 → Disable / Hot Reset / Loopback',
    ],
    physical: '全速全宽传输；周期性 SKP OS 补偿时钟差异；发送端保持有效信号，接收端持续保持锁定。',
    substates: [],
  },
  {
    key: 'Recovery',
    cn: '重训练',
    definition: '链路重新训练状态。重新建立位锁/块锁与去偏，并完成速率或宽度变更、低功耗返回。',
    entry: [
      'L0 中检测到错误或需要变速/变宽',
      '从 L1 退出',
      'L0s 退出失败',
      '软件请求重新训练',
    ],
    exit: [
      '训练成功 → L0（可能为新速率/宽度）',
      '多次失败 → 回退 Detect / Configuration',
    ],
    physical: '重新发送 TS1/TS2；Recovery.Speed 阶段 PLL 重新锁定；Gen3+ 可能执行发送/接收均衡（Equalization）。',
    substates: ['Recovery.RcvrLock', 'Recovery.Speed', 'Recovery.RcvrCfg', 'Recovery.Idle', 'Recovery.Equalization'],
  },
  {
    key: 'L0s',
    cn: '低功耗 L0s',
    definition: 'ASPM 快速低功耗状态。发送端进入电气空闲，链路可在很短时间内恢复到 L0。',
    entry: ['L0 中无待发 TLP/DLLP 且 ASPM L0s 使能', '发送 EIOS 有序集'],
    exit: ['发送 N_FTS 个 FTS 有序集 → L0（Gen1/2）', 'Gen3+ 通过 EIEOS/SDS 快速退出电气空闲'],
    physical: '仅关闭发送端以省电，接收端保持检测；恢复延迟远小于 L1。',
    substates: [],
  },
  {
    key: 'L1',
    cn: '低功耗 L1',
    definition: '更深的低功耗状态，需要双方协商进入；PHY 进入电气空闲，恢复需经过 Recovery。',
    entry: [
      'ASPM L1：PM_Active_State_Request_L1 / PM_Request_Ack 握手',
      '软件将设备置为 D1/D2/D3hot 触发 L1',
    ],
    exit: ['唤醒事件 → Recovery → L0', 'PME / Beacon 唤醒'],
    physical: 'PLL 与部分模拟电路可关闭，恢复时间比 L0s 长；L1 PM Substates 可进一步关闭参考时钟（L1.1）与 PHY 电源（L1.2），退出延迟逐级增大。',
    substates: [
      'L1.0：保持参考时钟，退出最快（µs 级）',
      'L1.1：CLKREQ# 释放，关闭参考时钟，退出需等待时钟稳定',
      'L1.2：PHY 电源门控，保留 Vcc/Vaux，退出延迟最长（数十 µs 级）',
    ],
    wake: ['CLKREQ# 拉低 → 恢复 REF CLK → Recovery → L0', 'PM_PME 消息上报唤醒原因'],
  },
  {
    key: 'L2',
    cn: '低功耗 L2',
    definition: '主电源关闭状态，仅 Vaux 供电，可通过 Beacon 或 WAKE# 请求系统唤醒。',
    entry: ['PME_Turn_Off / PME_TO_Ack 握手', 'PM_Enter_L23 指示进入 L2/L3', '软件置 D3cold'],
    exit: [
      'Beacon 唤醒：设备在电气空闲上发送低频信标 → 系统上电',
      'WAKE# 边带唤醒（传统实现）',
      'PM_PME 消息通知软件唤醒原因',
      '主电源恢复 → Fundamental Reset → Detect → 重新训练到 L0',
    ],
    physical: '主电源移除，PHY 与大部分逻辑关闭；仅保留 Beacon/WAKE# 检测电路与 Vaux 供电。唤醒后必须从 Detect 重新走完整链路训练，延迟远大于 L1。',
    substates: [],
  },
  {
    key: 'Hot Reset',
    cn: '热复位',
    definition: '带内复位。通过 TS1 的 Hot Reset 位复位链路两端，不需要 Fundamental Reset 引脚。',
    entry: ['软件置 Bridge Control.Secondary Bus Reset', '下游端口发送 16 个 Hot Reset=1 的 TS1'],
    exit: ['复位完成后进入 Detect，重新训练'],
    physical: '复位链路协议逻辑与状态机，不改变设备电源；常用于恢复挂死链路。',
    substates: [],
  },
  {
    key: 'Loopback',
    cn: '环回',
    definition: '测试状态。Loopback Master 发送带 Loopback 位的 TS1，Slave 将收到的数据原样回环。',
    entry: ['测试配置或软件指示', 'TS1 Training Control.Loopback=1'],
    exit: ['退出测试 → Detect'],
    physical: '用于链路完整性、误码率与均衡测试；回环路径验证发送/接收通路。',
    substates: [],
  },
  {
    key: 'Disable',
    cn: '禁用',
    definition: '软件禁用链路的状态。发送端处于电气空闲，接收端保持低阻。',
    entry: ['Link Control.Disable Link 置 1', '发送 16 个 Disable=1 的 TS1'],
    exit: ['软件清除 Disable Link → Detect 重新训练'],
    physical: '隔离故障或高功耗链路；链路不再传输任何数据。',
    substates: [],
  },
];

export function findLtssmInfo(key) {
  return LTSSM_INFO.find((s) => s.key === key) || null;
}
