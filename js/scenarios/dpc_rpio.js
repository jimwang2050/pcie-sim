import { resolveScenarioConfig } from './registry.js';
/**
 * 场景：DPC（Downstream Port Containment）+ RP PIO 错误隔离与恢复。
 *
 * 覆盖：
 *  - 软件使能 DPC：Interrupt Enable / Egress Control / RP PIO
 *  - L0 正常转发（MRd → CplD）
 *  - ERR_FATAL 触发 DPC：链路隔离（Disabled）、DPC 中断
 *  - Egress Control 丢弃下游 TLP；RP PIO 按错误严重级别终止 PIO 请求并返回 UR Completion（读数据全 1）
 *  - 软件清除 DPC Trigger → Hot Reset → 重新训练 → L0
 */
import { buildMem, buildCpl, buildMsg, hex32 } from '../core/tlp.js';
import {
  setupLinkL0, tlpPair, ackPair, US, RC_ID, EP_ID,
} from './mem_common.js';

export function buildDpcRpio(sim, opts = {}) {
  resolveScenarioConfig('dpc_rpio', opts);
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
  const msi = sim.msi;
  const dpc = sim.dpc;
  msi.reset();
  msi.enableMsi(4);
  dpc.reset();

  const ADDR = 0x80002000;
  const tag = 3;

  sim.at(0, () => {
    sim.beginPhase('dpc_cfg', 'DPC 使能', 'dpc',
      '软件配置 DPC Capability：Interrupt Enable / Egress Control / RP PIO 错误严重级别');
    link.setBoth('L0', 'RC / EP：L0（链路正常工作）', 'DPC 尚未触发，下游 TLP 正常转发');
  });

  sim.at(4 * US, () => {
    dpc.enable({ egressControl: true, rpPio: true });
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'DPC',
      summary: '软件使能 DPC：Interrupt Enable=1 · Egress Control=1 · RP PIO Error Control=1',
      detail: 'DPC 是 Downstream Port 的扩展能力（0x1D）：检测到不可纠正错误后自动隔离下游链路；RP PIO 按 Config/IO/Memory × UR/CA/CTO 配置严重级别',
      status: 'ok',
    });
  });

  // ---------- 正常转发 ----------
  sim.at(18 * US, () => sim.beginPhase('dpc_normal', 'L0 正常转发', 'l0',
    'DPC 使能但未触发：MRd / CplD 正常通过 Root Port'));
  const req = buildMem({
    write: false, address: ADDR, is64: true, lengthDw: 16, requester: RC_ID, tag,
  });
  const cpl = buildCpl({
    requester: RC_ID, completer: EP_ID, tag, dataDws: [0x11111111, 0x22222222], byteCount: 8,
  });
  tlpPair(sim, 24 * US, 'RC', 'EP', req,
    `MRd  Addr=${hex32(ADDR)}  Len=16DW  Tag=${tag}`,
    'Non-Posted 读请求经 Root Port 正常下泄', () => sim.fc.consume('RC', 'NP_Hdr', 1));
  ackPair(sim, 28 * US, 'EP', 'RC', `MRd Tag=${tag}`);
  tlpPair(sim, 38 * US, 'EP', 'RC', cpl, `CplD  Tag=${tag}  8B`,
    'Completion 正常返回，DPC 未触发');

  // ---------- 错误触发 DPC ----------
  sim.at(56 * US, () => sim.beginPhase('dpc_trigger', 'ERR_FATAL 触发 DPC', 'dpc',
    '下游端口检测到不可纠正错误，DPC 自动隔离链路并产生中断'));
  sim.at(60 * US, () => {
    sim.emit({
      layer: 'DLL', row: 'EP.DLL', side: 'EP', dir: 'RX', type: 'ERROR',
      summary: 'EP 检出不可纠正错误：Poisoned TLP / Completion Timeout',
      detail: 'Fatal 错误；继续下泄可能污染系统内存，需要 DPC 隔离',
      status: 'error',
    });
  });
  const errMsg = buildMsg({ code: 0x33, requester: EP_ID, tag: 0 });
  tlpPair(sim, 64 * US, 'EP', 'RC', errMsg, 'ERR_FATAL 消息',
    'Uncorrectable Fatal：上报 Root Port', null, 'ERR_FATAL');

  sim.at(74 * US, () => {
    dpc.trigger('ERR_FATAL');
    dpc.contain();
    link.linkUp = false;
    link.setBoth('Disable', 'RC / EP：链路 Disable（DPC 隔离 / DL_Down）',
      'DPC Triggered=1，下游链路被隔离，后续 TLP 不再下泄');
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'DPC',
      summary: 'DPC 触发：Trigger Reason=ERR_FATAL，链路进入 Disabled',
      detail: 'DPC Status.Triggered=1；Root Port 停止转发下游请求',
      status: 'error',
    });
  });
  sim.at(78 * US, () => {
    const ok = msi.trigger(0);
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'INT',
      summary: 'DPC 中断 → MSI Vector 0',
      detail: ok ? '软件可由 DPC Status 读取触发原因' : '中断被屏蔽',
      status: ok ? 'ok' : 'idle',
    });
  });

  // ---------- 隔离与 RP PIO ----------
  sim.at(88 * US, () => sim.beginPhase('dpc_contain', 'Egress Control + RP PIO', 'dpc',
    '阻止下游 TLP；RP PIO 按配置的严重级别终止 PIO 请求并返回 UR Completion'));
  sim.at(92 * US, () => {
    dpc.block();
    sim.emit({
      layer: 'TL', row: 'RC.TL', side: 'RC', dir: 'TX', type: 'DPC',
      summary: 'Egress Control 丢弃下游 MRd（Tag 3）',
      detail: 'DPC Egress Control 阻止 TLP 继续发往下游端口',
      packet: buildMem({ write: false, address: ADDR, is64: true, lengthDw: 16, requester: RC_ID, tag }),
      dur_ns: 4 * US,
      status: 'error',
    });
  });
  sim.at(100 * US, () => {
    dpc.urCompletion();
    sim.emit({
      layer: 'TL', row: 'RC.TL', side: 'RC', dir: 'TX', type: 'Cpl',
      summary: 'RP PIO → UR Completion（Tag 3，Status=UR，读数据全 1）',
      detail: 'RP PIO 错误终止：按配置的严重级别结束该 PIO 读请求，请求方不会挂死或等到 Completion Timeout',
      packet: buildCpl({ requester: RC_ID, completer: RC_ID, tag, status: 1 }),
      dur_ns: 4 * US,
      status: 'error',
    });
  });
  sim.at(110 * US, () => {
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'DONE',
      summary: 'Containment 生效：下游流量被隔离，请求方收到 UR',
      detail: `已阻止 ${dpc.blocked} 条 TLP，生成 ${dpc.urCompletions} 条 UR Completion`,
      status: 'ok',
    });
  });

  // ---------- 软件恢复 ----------
  sim.at(122 * US, () => sim.beginPhase('dpc_recover', '软件清除 DPC 并恢复链路', 'recovery',
    '写 DPC Control.Trigger=0 → Hot Reset → 重新训练到 L0'));
  sim.at(126 * US, () => {
    dpc.clear();
    dpc.state = 'recovering';
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'DPC',
      summary: '软件写 DPC Control.Trigger=0，清除 DPC',
      detail: '读取 DPC Status 记录触发原因后清除，准备复位链路',
      status: 'ok',
    });
  });
  sim.at(134 * US, () => {
    link.setBoth('Hot Reset', 'RC / EP：Hot Reset', '通过带内复位清除下游端口错误状态');
  });
  sim.at(146 * US, () => {
    link.setBoth('Detect.Quiet', 'RC / EP：回到 Detect', '复位后重新开始链路训练');
  });
  sim.at(158 * US, () => {
    link.linkUp = true;
    link.setBoth('L0', 'RC / EP：恢复 L0', 'DPC 已清除，链路恢复，可重新枚举下游设备');
    dpc.state = 'normal';
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'DONE',
      summary: 'DPC 恢复完成：链路回到 L0',
      detail: '软件需要重新配置下游设备并清除 AER 状态',
      status: 'ok',
    });
  });

  sim.at(168 * US, () => sim.endPhase());

  sim.durationNs = 180 * US;
  return {
    gen,
    width,
    durationNs: sim.durationNs,
    totalSteps: sim.pending,
    rows: sim.rows,
    defaultRow: null,
  };
}
