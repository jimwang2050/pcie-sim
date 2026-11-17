import { resolveScenarioConfig } from './registry.js';
/**
 * 场景：LTSSM 电源管理（L0 → L0s → L0 → L1 → Recovery → L0 → L2 → 唤醒）。
 *
 * 覆盖：
 *  - ASPM L0s：EIOS 进入、FTS 退出（无需平台参与）
 *  - ASPM L1：PM_Active_State_Request_L1 / PM_Request_Ack 握手
 *  - L1 PM Substates：L1.0 → L1.1（关 REF CLK）→ L1.2（PHY 电源门控）
 *  - CLKREQ# 唤醒：L1 退出 → Recovery.RcvrLock → RcvrCfg → Idle → L0
 *  - L2 进入：PME_Turn_Off / PME_TO_Ack / PM_Enter_L23
 *  - Beacon 唤醒：Vaux 下发送信标 → 主电源恢复 → Detect 全量重训练
 *  - 唤醒机制总结 + PM_PME 原因上报
 *  - 热插拔：PRSNT# → 槽位上电 → PERST# 释放 → 训练 → DLLSC / 热插拔中断 → 安全拔出
 */
import {
  RATE_BY_GEN,
  ratesBitmap,
  buildOrderedSet,
} from '../core/packet.js';
import { buildDllp, buildPmMessage } from '../core/dllp.js';

const US = 1000;

export function buildLtssmPm(sim, opts = {}) {
  resolveScenarioConfig('ltssm_pm', opts);
  const gen = opts.gen ?? 3;
  const width = opts.width ?? 8;
  const link = sim.link;

  link.configure({ gen, width, mode: 'auto' });
  link.reset();
  link.linkUp = true;
  link.setRate(gen);
  link.setLaneNumbers(Array.from({ length: width }, (_, i) => i));
  sim.phy.stabilizeRefClk();
  sim.phy.lockPll();
  sim.phy.cdrBitLock();
  sim.phy.setOperatingRate(gen);
  sim.phy.setEqPhase(gen >= 3 ? 3 : 0, gen >= 3 ? 10 : 0);
  sim.pm.enable();

  sim.rows = [
    { key: 'STATE', label: 'LTSSM 状态' },
    { key: 'RC.DLL', label: 'RC · DLL' },
    { key: 'RC.PHY', label: 'RC · PHY' },
    { key: 'EP.PHY', label: 'EP · PHY' },
    { key: 'EP.DLL', label: 'EP · DLL' },
  ];

  const laneAll = Array.from({ length: width }, (_, i) => i);
  const nFts = gen <= 2 ? 4 : 12;
  const rates = ratesBitmap(gen);
  const flitMode = link.flitMode;

  const at = (t, fn) => sim.at(t, fn);

  function state(t, st, summary, detail) {
    at(t, () => link.setBoth(st, summary, detail));
  }

  function phy(t, side, type, summary, packet = null, dur = 0) {
    at(t, () => {
      sim.emit({
        layer: 'PHY',
        row: `${side}.PHY`,
        side,
        dir: 'TX',
        type,
        summary,
        packet,
        dur_ns: dur,
        status: 'ok',
      });
    });
  }

  function os(t, side, kind, label) {
    const packet = buildOrderedSet(kind, {
      gen, width, nFts, link: 0, laneNumbers: laneAll, rates, flitMode,
    });
    phy(t, side, kind, `${side} 发送 ${kind}（${label}）`, packet, packet.realTimeNs);
  }

  function dllp(t, from, to, name, label) {
    const packet = buildDllp(name);
    at(t, () => {
      sim.emit({
        layer: 'DLL',
        row: `${from}.DLL`,
        side: from,
        dir: 'TX',
        type: 'DLLP',
        summary: `${from} → ${to} 发送 ${name}（${label}）`,
        packet,
        dur_ns: 4 * US,
        status: 'ok',
      });
    });
    at(t + 2 * US, () => {
      sim.emit({
        layer: 'DLL',
        row: `${to}.DLL`,
        side: to,
        dir: 'RX',
        type: 'DLLP',
        summary: `${to} 接收 ${name}`,
        packet,
        dur_ns: 4 * US,
        status: 'ok',
      });
    });
  }

  function msg(t, from, to, name, label) {
    const packet = buildPmMessage(name);
    at(t, () => {
      sim.emit({
        layer: 'DLL',
        row: `${from}.DLL`,
        side: from,
        dir: 'TX',
        type: 'MSG',
        summary: `${from} → ${to} 发送 ${name}（${label}）`,
        packet,
        dur_ns: 5 * US,
        status: 'ok',
      });
    });
    at(t + 2 * US, () => {
      sim.emit({
        layer: 'DLL',
        row: `${to}.DLL`,
        side: to,
        dir: 'RX',
        type: 'MSG',
        summary: `${to} 接收 ${name}`,
        packet,
        dur_ns: 5 * US,
        status: 'ok',
      });
    });
  }

  // 边带 / 电源管理事件（CLKREQ#、Beacon、WAKE# 等）
  function pm(t, side, summary) {
    at(t, () => {
      sim.emit({
        layer: 'PHY',
        row: `${side}.PHY`,
        side,
        dir: 'TX',
        type: 'PM',
        summary,
        packet: null,
        dur_ns: 2 * US,
        status: 'ok',
      });
    });
  }

  // ---------- 基线 L0 ----------
  // 首个动作同时开启阶段并置 L0：保证复位后立刻产生一条事件，流程视图不会空白
  at(0, () => {
    sim.beginPhase('l0', 'L0 正常工作', 'l0', `链路已训练完成（${RATE_BY_GEN[gen]} × x${width}）`);
    link.setBoth('L0', 'RC / EP：L0（链路正常工作）', '以 L0 为基准，依次演示 L0s / L1 / L2 进入与退出');
  });
  phy(8, 'RC', 'SKP', 'RC 发送 SKP OS 维持链路同步', buildOrderedSet('SKP', {
    gen, width, nFts, link: 0, laneNumbers: laneAll, rates, flitMode,
  }));

  // ---------- ASPM L0s ----------
  at(24 * US, () => sim.beginPhase('l0s', 'ASPM L0s 进入/退出', 'l0s', '发送端进入电气空闲，恢复时间短'));
  os(24 * US, 'RC', 'EIOS', '进入 L0s：发送电气空闲有序集');
  state(28 * US, 'L0s', 'RC / EP：进入 L0s', 'L0s 为 ASPM 快速低功耗状态；发送端进入电气空闲');
  phy(64 * US, 'RC', 'FTS', `RC 发送 N_FTS=${nFts} 个 FTS 有序集（退出 L0s）`, null, 0);
  state(68 * US, 'L0', 'RC / EP：退出 L0s，回到 L0', 'FTS 用于快速重新获得位锁与符号锁');

  // ---------- ASPM L1 协商 ----------
  at(110 * US, () => sim.beginPhase('l1_req', 'ASPM L1 协商', 'pm', '通过 DLLP 握手请求并确认进入 L1'));
  dllp(110 * US, 'EP', 'RC', 'PM_Active_State_Request_L1', '上游端口发起 ASPM L1 请求');
  dllp(132 * US, 'RC', 'EP', 'PM_Request_Ack', '下游端口同意进入 L1');

  at(154 * US, () => sim.beginPhase('l1', 'L1 低功耗 + L1 PM Substates', 'l1', 'L1.0 → L1.1 → L1.2：逐步关闭参考时钟与 PHY 电源'));
  state(154 * US, 'L1.0', 'RC / EP：进入 L1.0', '保持参考时钟，退出延迟最短（µs 级）');
  os(158 * US, 'RC', 'EIOS', '进入 L1 前的电气空闲');
  os(158 * US, 'EP', 'EIOS', '进入 L1 前的电气空闲');
  at(160 * US, () => sim.pm.setL1Sub('L1.0'));

  pm(172 * US, 'EP', 'EP 释放 CLKREQ#，允许关闭参考时钟（→ L1.1）');
  pm(172 * US, 'RC', 'RC 检测到 CLKREQ# 释放，关闭 REF CLK');
  state(174 * US, 'L1.1', 'RC / EP：L1.1（参考时钟关闭）', 'L1 PM Substates：CLKREQ# 释放后关闭参考时钟，进一步省电');
  at(174 * US, () => sim.pm.setL1Sub('L1.1'));

  pm(186 * US, 'EP', 'EP 进入 L1.2：PHY 电源门控（保持 Vcc / Vaux）');
  state(188 * US, 'L1.2', 'RC / EP：L1.2（电源门控）', 'L1.2 关闭 PHY 大部分电路，退出延迟最长（数十 µs 级）');
  at(188 * US, () => sim.pm.setL1Sub('L1.2'));

  // ---------- L1.2 唤醒：CLKREQ# 路径（与 Beacon 相互独立） ----------
  at(194 * US, () => sim.beginPhase('l1_wake', 'CLKREQ# 唤醒（L1 退出）', 'wake',
    '物理过程：EP 拉低 CLKREQ# → 平台恢复 REF CLK → PLL 锁定 → Recovery 重新建立位锁'));
  pm(198 * US, 'EP', 'EP 拉低 CLKREQ#（开漏、低有效），请求恢复参考时钟');
  pm(202 * US, 'RC', 'RC / 平台恢复 REF CLK，等待时钟稳定（SSC / ppm 收敛）');
  state(204 * US, 'L1.2', 'RC / EP：L1.2 唤醒中', 'CLKREQ# 唤醒 → 参考时钟恢复 → PLL 锁定 → Recovery');

  // ---------- L1 退出 ----------
  at(206 * US, () => sim.beginPhase('l1_exit', 'L1 退出（Recovery）', 'recovery', 'CLKREQ# 唤醒后重新建立位锁/块锁并回到 L0'));
  state(206 * US, 'Recovery.RcvrLock', 'RC / EP：进入 Recovery.RcvrLock', '发送 TS1 重新锁定');
  os(210 * US, 'RC', 'TS1', 'L1 退出：RcvrLock');
  os(210 * US, 'EP', 'TS1', 'L1 退出：RcvrLock');

  state(236 * US, 'Recovery.RcvrCfg', 'RC / EP：进入 Recovery.RcvrCfg', '交换 TS2 恢复配置');
  os(240 * US, 'RC', 'TS2', 'RcvrCfg');
  os(240 * US, 'EP', 'TS2', 'RcvrCfg');

  state(266 * US, 'Recovery.Idle', 'RC / EP：进入 Recovery.Idle', '准备回到 L0');
  os(270 * US, 'RC', 'TS2', 'Recovery.Idle');
  os(270 * US, 'EP', 'TS2', 'Recovery.Idle');

  at(292 * US, () => sim.beginPhase('l0b', 'L0 恢复', 'l0', 'L1.2 唤醒完成，链路重新开始正常传输'));
  state(292 * US, 'L0', 'RC / EP：回到 L0', '低功耗退出完成');
  msg(300 * US, 'EP', 'RC', 'PM_PME', '唤醒后上报 PME，通知软件唤醒原因（PM_PME 只上报原因，不负责拉起链路）');

  // ---------- L2 进入 ----------
  at(330 * US, () => sim.beginPhase('l2_req', 'L2 进入握手', 'pm', 'PME_Turn_Off → PME_TO_Ack → PM_Enter_L23'));
  msg(330 * US, 'RC', 'EP', 'PME_Turn_Off', '电源管理软件请求进入 L2/L3');
  msg(362 * US, 'EP', 'RC', 'PME_TO_Ack', '上游端口确认收到关机请求');
  dllp(394 * US, 'RC', 'EP', 'PM_Enter_L23', '完成 L2/L3 进入握手');

  at(420 * US, () => sim.beginPhase('l2', 'L2 低功耗', 'l2', '主电源关闭，仅 Vaux 可用'));
  state(420 * US, 'L2', 'RC / EP：进入 L2', '主电源关闭，仅保留 Vaux；可由 Beacon / WAKE# / PM_PME 唤醒');
  os(424 * US, 'RC', 'EIOS', '进入 L2 前的电气空闲');
  os(424 * US, 'EP', 'EIOS', '进入 L2 前的电气空闲');

  // ---------- L2 唤醒：Beacon 路径（与 CLKREQ# 相互独立） ----------
  at(448 * US, () => sim.beginPhase('l2_wake', 'Beacon 唤醒（L2 物理过程）', 'wake',
    'L2 只有 Vaux：EP 在差分对上发送 Beacon 脉冲串 → RC 检测 → 平台恢复主电源'));
  pm(452 * US, 'EP', 'EP 在 Vaux 供电下于差分对发送 Beacon 脉冲串（周期性低频信标，不是正常编码数据）');
  pm(456 * US, 'RC', 'RC 的 Beacon 检测电路（常驻 Vaux）识别信标，向平台发出唤醒请求');

  at(460 * US, () => {
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'PM',
      summary: '替代路径：设备拉低 WAKE#（开漏、低有效）同样可请求主电源恢复，不依赖 Beacon',
      detail: '平台 / 设备支持其一即可；两条路径都只负责“唤醒电源”，链路仍需重新训练',
      status: 'ok',
    });
  });

  pm(464 * US, 'RC', '主电源恢复，Fundamental Reset 释放，REF CLK 稳定');
  state(468 * US, 'Detect', 'RC / EP：唤醒后回到 Detect', 'L2 退出没有保留链路上下文，必须从 Detect 重新训练');

  // ---------- L2 唤醒后的全量重训练 ----------
  at(472 * US, () => sim.beginPhase('l2_retrain', 'Beacon 唤醒后重新训练', 'recovery',
    'Detect → Polling → Configuration → L0：与上电冷启动的训练流程一致'));
  os(476 * US, 'RC', 'TS1', '唤醒重训练：Detect → Polling');
  os(476 * US, 'EP', 'TS1', '唤醒重训练：Detect → Polling');

  state(486 * US, 'Polling.Active', 'RC / EP：Polling.Active', '发送 TS1/TS2 重新建立位锁与符号锁');
  os(492 * US, 'RC', 'TS2', 'Polling');
  os(492 * US, 'EP', 'TS2', 'Polling');

  state(504 * US, 'Configuration.Linkwidth.Start', 'RC / EP：Configuration', '重新协商链路宽度与速率');
  os(510 * US, 'RC', 'TS1', 'Configuration');
  os(510 * US, 'EP', 'TS1', 'Configuration');

  state(524 * US, 'L0', 'RC / EP：唤醒完成，回到 L0', 'Beacon 唤醒成功；可上报 PM_PME 说明唤醒原因');
  msg(532 * US, 'EP', 'RC', 'PM_PME', '唤醒后上报 PME');

  // ---------- 唤醒机制总结 ----------
  at(540 * US, () => sim.beginPhase('pm_summary', '唤醒机制总结', 'pm',
    '三类链路唤醒路径 + PME 原因上报，退出延迟与所需平台配合各不相同'));

  const summary = (t, text, detail) => at(t, () => sim.emit({
    layer: 'STATE', row: 'STATE', type: 'PM',
    summary: text, detail, status: 'ok',
  }));
  summary(542 * US, 'L0s → L0：靠 FTS 有序集快速退出，不需要平台参与',
    '发送端电气空闲后，用 N_FTS 个 FTS 快速重新获得位锁 / 符号锁，延迟最短');
  summary(546 * US, 'L1.0–L1.2 → L0：CLKREQ# 请求 REF CLK → Recovery 重建锁定',
    'L1.1 关闭参考时钟、L1.2 电源门控；唤醒必须先恢复时钟，再经 Recovery 回到 L0');
  summary(550 * US, 'L2 → L0：Beacon 或 WAKE# 触发主电源恢复 → Detect 全量重训练',
    'L2 仅 Vaux 供电，链路时钟与上下文已丢失，无法只靠 CLKREQ# 唤醒');
  summary(554 * US, 'PME / PM_PME：只上报唤醒原因，不负责把链路拉起来',
    'PM_PME 是正常 TLP 路径上的 Message（0x18）；D3cold / L2 需先恢复电源才能发送');

  at(558 * US, () => sim.endPhase());

  // ---------- 热插拔（Hot-Plug） ----------
  const hp = sim.hotplug;
  function hpEv(t, summary, detail, mutate) {
    at(t, () => {
      if (mutate) mutate();
      sim.emit({
        layer: 'PHY', row: 'RC.PHY', side: 'RC', dir: '-', type: 'PM',
        summary, detail, status: 'ok', dur_ns: 2 * US,
      });
    });
  }
  function hpInt(t, label, detail) {
    at(t, () => {
      const ok = sim.msi.trigger(1);
      hp.interrupt();
      sim.emit({
        layer: 'STATE', row: 'STATE', type: 'INT',
        summary: `热插拔中断 → ${label}`,
        detail: ok ? detail : '中断被屏蔽',
        status: ok ? 'ok' : 'idle',
      });
    });
  }

  at(572 * US, () => {
    sim.beginPhase('hp_insert', '热插拔 · 插入与上电', 'hotplug',
      'PRSNT# 检测 → 槽位上电 → PERST# 释放 → 链路训练到 L0 → DLLSC');
    hp.enable();
    sim.msi.reset();
    sim.msi.enableMsi(2);
    link.linkUp = false;
    link.setBoth('Detect.Quiet', 'RC：槽位为空（无设备）', '热插拔演示从“空槽”开始，链路处于未连接状态');
  });

  hpEv(576 * US, 'PRSNT# 变为 0：槽位检测到设备插入',
    'PRSNT# 是插卡在位信号，0 表示在位；它是整个热插拔流程的触发源',
    () => hp.insert());
  hpEv(580 * US, 'Power Controller 上电：Vcc / Vaux 正常，Power Fault=0',
    '软件（或硬件自动）写 Slot Control 打开槽位电源；上电期间 Power Indicator 闪烁',
    () => hp.powerOn());
  hpEv(586 * US, 'PERST# 释放（Fundamental Reset 解除），REF CLK 稳定',
    '电源稳定后才允许释放复位，否则链路训练可能失败',
    () => hp.releasePerst());
  state(590 * US, 'Detect', 'RC / EP：Detect', '复位释放后链路从 Detect 开始训练');
  state(596 * US, 'Polling.Active', 'RC / EP：Polling.Active', '热插拔上电后的常规训练流程');
  os(600 * US, 'RC', 'TS1', '热插拔：Polling');
  state(606 * US, 'Configuration.Linkwidth.Start', 'RC / EP：Configuration', '协商宽度与速率');
  os(610 * US, 'RC', 'TS1', '热插拔：Configuration');
  state(616 * US, 'L0', 'RC / EP：回到 L0', '设备可用');
  hpEv(620 * US, 'DLLSC：Link Up → Slot Status.DLLSC=1',
    'Data Link Layer State Changed：链路激活/断开时置位，是软件感知插拔的主要事件',
    () => hp.setLinkUp());
  hpInt(624 * US, 'MSI Vector 1（DLLSC）', '软件读 Slot Status，确认链路已 Up 后开始枚举新设备');

  at(632 * US, () => sim.beginPhase('hp_attention', '热插拔 · Attention Button / 指示灯', 'hotplug',
    '用户按下 Attention Button 请求安全拔出，指示灯闪烁提示'));
  hpEv(636 * US, '用户按下 Attention Button（ATNBTN#）',
    'Attention Button 用于请求安全拔出 / 插入，避免带电操作损坏设备',
    () => hp.pressAttention());
  hpEv(640 * US, 'Power Indicator 闪烁：提示可安全拔出',
    '指示灯由 Slot Control 控制；软件确认无访问后才会断电');
  hpInt(644 * US, 'MSI Vector 1（Attention Button Pressed）',
    '软件读 Slot Status.Attention Button Pressed 并清除，随后关闭槽位电源');

  at(652 * US, () => sim.beginPhase('hp_remove', '热插拔 · 拔出与链路断开', 'hotplug',
    'PRSNT# 变化 → 链路 DL_Down → DLLSC + 热插拔中断 → 槽位断电'));
  hpEv(656 * US, '用户拔出设备 / 打开 MRL：PRSNT# 变为 1',
    'MRL（手动保持锁）确保拔出前设备已断电；PRSNT# 变化是拔出事件源',
    () => hp.remove());
  at(660 * US, () => {
    link.linkUp = false;
    hp.setLinkDown();
    link.setBoth('Detect.Quiet', 'RC：链路断开，回到 Detect', '设备移除后下游端口进入 DL_Down');
  });
  hpEv(664 * US, 'DLLSC：Link Down → Slot Status.DLLSC=1', '链路断开同样产生 DLLSC 事件');
  hpInt(668 * US, 'MSI Vector 1（DLLSC / Link Down）', '软件收到中断后标记设备已移除并释放资源');
  hpEv(674 * US, 'Power Controller 断电，槽位回到空槽',
    '拔出后关闭槽位电源，等待下一次插入',
    () => hp.powerOff());

  at(682 * US, () => sim.beginPhase('hp_summary', '热插拔机制总结', 'pm',
    '上电时序、DLLSC / 中断通知、安全拔出三条主线'));
  summary(684 * US, '上电时序：PRSNT# → Power Controller → 电源稳定 → PERST# 释放 → 链路训练',
    '顺序不能颠倒：复位释放过早会导致训练失败');
  summary(688 * US, '状态通知：Link Up / Down 都置 DLLSC，并产生热插拔中断（MSI / MSI-X / INTx）',
    '软件通过 Slot Status 区分插入、拔出与 Attention Button 事件');
  summary(692 * US, '安全拔出：Attention Button + Power Indicator + MRL 配合，先断电再拔卡',
    '热插拔是槽位能力，与设备 D 状态无关；D3cold 插卡同样走这条流程');

  at(698 * US, () => sim.endPhase());

  sim.durationNs = 710 * US;
  return {
    gen,
    width,
    mode: link.flitMode ? 'flit' : 'nonflit',
    flitMode: link.flitMode,
    durationNs: sim.durationNs,
    totalSteps: sim.pending,
    rows: sim.rows,
  };
}
