/**
 * 场景：D 状态（软件，PMCSR 可见）/ P 状态（PHY 侧 PIPE PowerDown 编码）。
 * D0(P0/P1/P2) → D1 → D0 → D3hot(PME 唤醒) → D3cold → Fundamental Reset。
 */
import { buildCfg, buildMsg } from '../core/tlp.js';
import { setupLinkL0, tlpPair, ackPair, US, RC_ID, EP_ID } from './mem_common.js';

export function buildPmDp(sim, opts = {}) {
  const gen = opts.gen ?? 3;
  const width = opts.width ?? 8;
  setupLinkL0(sim, gen, width, [
    { key: 'STATE', label: 'LTSSM 状态' },
    { key: 'RC.TL', label: 'RC · TL' },
    { key: 'RC.DLL', label: 'RC · DLL' },
    { key: 'EP.DLL', label: 'EP · DLL' },
    { key: 'EP.TL', label: 'EP · TL' },
  ]);

  const link = sim.link;
  const pm = sim.pm;
  pm.reset();
  pm.enable();

  function pmEvent(t, summary, detail) {
    sim.at(t, () => sim.emit({
      layer: 'STATE', row: 'STATE', type: 'PM',
      summary, detail, status: 'ok',
    }));
  }

  function cfgWrite(t, value, label, onWrite) {
    const pkt = buildCfg({
      write: true, bdf: EP_ID, reg: 0x44, requester: RC_ID, tag: value & 0xff, data: value,
    });
    tlpPair(sim, t, 'RC', 'EP', pkt, label, 'PMCSR 位于 PM Capability 偏移 0x44', onWrite);
    ackPair(sim, t + 4 * US, 'EP', 'RC', 'CfgWr0 PMCSR');
  }

  sim.at(0, () => {
    sim.beginPhase('d0', 'D0 / P0', 'pm', 'D0 全功能，P0 = PHY 全速（PIPE PowerDown=00）');
    link.setBoth('L0', 'RC / EP：L0', '设备处于 D0，链路正常工作');
  });
  pmEvent(2 * US, 'D0 · P0：PIPE PowerDown=00 / 10 W',
    'D0 由软件写 PMCSR 控制；P0 是 PHY 的 powerdown 编码，软件不直接可见');

  // ---------- P 状态（PHY 侧 PIPE PowerDown） ----------
  pmEvent(20 * US, 'P1：PIPE PowerDown=01（PLL 保持、时钟门控）/ 6 W',
    'PHY 降低门控深度；D0 与链路 L0 不变', () => pm.setPState(1));
  pmEvent(40 * US, 'P2：PIPE PowerDown=10（PLL 关断）/ 3 W',
    'PHY 深度门控；P2 不等于 L2，此时链路仍在 L0', () => pm.setPState(2));
  pmEvent(60 * US, 'P0：PHY 恢复全速（PowerDown=00）/ 10 W',
    'PHY 恢复全速，链路保持 L0', () => pm.setPState(0));

  // ---------- D1 ----------
  sim.at(76 * US, () => sim.beginPhase('d1', 'D1 睡眠', 'pm', '写 PMCSR PowerState=D1'));
  cfgWrite(80 * US, 0x0001, 'CfgWr0  PMCSR=0x0001（PowerState=D1）', () => pm.writePmcsr(0x0001));
  sim.at(82 * US, () => {
    link.setBoth('L1', 'RC / EP：L1', 'EP 进入 D1，链路进入 L1 低功耗');
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'PM',
      summary: `D1：链路 L1 / ${pm.powerW} W`,
      detail: '配置空间仍可访问；需要软件恢复设备上下文', status: 'ok',
    });
  });

  // ---------- 回到 D0 ----------
  cfgWrite(110 * US, 0x0000, 'CfgWr0  PMCSR=0x0000（PowerState=D0）', () => pm.writePmcsr(0x0000));
  sim.at(112 * US, () => {
    link.setBoth('L0', 'RC / EP：L0', 'EP 回到 D0');
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'PM',
      summary: `D0 · P${pm.pstate}：${pm.powerW} W`,
      detail: '链路恢复 L0', status: 'ok',
    });
  });

  // ---------- D3hot + PME ----------
  sim.at(136 * US, () => sim.beginPhase('d3', 'D3hot + PME', 'pm',
    '写 PMCSR PowerState=D3hot 且 PME_En=1'));
  cfgWrite(140 * US, 0x0103, 'CfgWr0  PMCSR=0x0103（PME_En=1, PowerState=D3hot）',
    () => pm.writePmcsr(0x0103));
  sim.at(142 * US, () => {
    link.setBoth('L1', 'RC / EP：L1', 'EP 进入 D3hot，Vcc 仍存在');
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'PM',
      summary: `D3hot：链路 L1 / ${pm.powerW} W / PME_En=1`,
      detail: 'D3hot 下可通过 PME 请求唤醒', status: 'ok',
    });
  });

  const pme = buildMsg({ code: 0x18, requester: EP_ID, tag: 0 });
  tlpPair(sim, 170 * US, 'EP', 'RC', pme, 'PM_PME 消息（请求唤醒）',
    '设备在 D3hot 下发出 PME，RC 收到后由软件恢复设备', null, 'PM_PME');
  ackPair(sim, 174 * US, 'RC', 'EP', 'PM_PME');
  sim.at(172 * US, () => {
    const ok = pm.triggerPme();
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'PM',
      summary: ok ? 'PME 已挂起（PME_Status=1）' : 'PME 未使能，无法发出',
      detail: '软件通过 PMCSR 写 D0 完成唤醒', status: ok ? 'ok' : 'error',
    });
  });

  // ---------- 唤醒回 D0 ----------
  sim.at(188 * US, () => sim.beginPhase('wake', 'PME 唤醒', 'pm', '软件写 PMCSR 回到 D0'));
  cfgWrite(190 * US, 0x8000, 'CfgWr0  PMCSR=0x8000（PowerState=D0，写 1 清 PME_Status）',
    () => pm.writePmcsr(0x8000));
  sim.at(192 * US, () => {
    link.setBoth('L0', 'RC / EP：L0', 'PME 唤醒完成，设备回到 D0');
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'PM',
      summary: `唤醒完成：D0 · P${pm.pstate} / ${pm.powerW} W`,
      detail: '链路恢复 L0，PME_Status 被清除', status: 'ok',
    });
  });

  // ---------- D3cold / 复位 ----------
  sim.at(216 * US, () => sim.beginPhase('d3cold', 'D3cold', 'pm',
    '移除 Vcc：链路关闭，只能通过 Fundamental Reset 恢复'));
  pmEvent(220 * US, 'D3cold：Vcc 移除，功耗 0 W',
    '链路进入 Detect；所有上下文丢失，需要 Fundamental Reset', () => {
    pm.setDState('D3cold');
    link.linkUp = false;
    link.setBoth('Detect.Quiet', 'RC / EP：Detect.Quiet', 'D3cold 后链路无电源');
  });

  sim.at(248 * US, () => sim.beginPhase('reset', 'Fundamental Reset', 'pm',
    '上电复位后设备回到 D0uninitialized'));
  pmEvent(250 * US, 'Fundamental Reset：D0uninitialized',
    '复位释放后软件必须重新枚举与配置', () => {
    pm.setDState('D0');
    pm.setPState(0);
  });
  pmEvent(264 * US, 'D0active：链路重新训练到 L0',
    '设备恢复全功能；配置空间恢复默认值', () => {
    link.linkUp = true;
    link.setBoth('L0', 'RC / EP：L0', '复位后重新训练完成');
  });

  sim.at(280 * US, () => sim.endPhase());
  sim.durationNs = 292 * US;
  return {
    gen,
    width,
    durationNs: sim.durationNs,
    totalSteps: sim.pending,
    rows: sim.rows,
    defaultRow: null,
  };
}
