import { resolveScenarioConfig } from './registry.js';
/**
 * 场景：Gen6 Flit 深入。
 * 打包多个 TLP → FEC/CRC 校验 → 可纠正错误 → 不可纠错误 → Flit 级重传。
 */
import { buildMem } from '../core/tlp.js';
import { buildFlit, checkFlit } from '../core/flit.js';
import { setupLinkL0, US } from './mem_common.js';

function snapFlit(f) {
  return {
    ...f,
    check: { ...f.check },
    fec: { ...f.fec },
    crc: { ...f.crc },
    dlp: { ...f.dlp },
    retry: { ...f.retry },
  };
}

export function buildFlitGen6(sim, opts = {}) {
  resolveScenarioConfig('flit_gen6', opts);
  const width = opts.width ?? 8;
  setupLinkL0(sim, 6, width, [
    { key: 'STATE', label: 'LTSSM 状态' },
    { key: 'RC.TL', label: 'RC · TL' },
    { key: 'RC.FLIT', label: 'RC · FLIT' },
    { key: 'EP.FLIT', label: 'EP · FLIT' },
    { key: 'EP.TL', label: 'EP · TL' },
  ]);

  const link = sim.link;
  const stats = sim.flit;
  stats.reset();
  stats.enable();

  const t1 = buildMem({
    write: true, address: 0x80001000, is64: true, lengthDw: 2,
    requester: 0x0000, tag: 0, dataDws: [0xa5a5a5a5, 0x5a5a5a5a],
  });
  const t2 = buildMem({
    write: true, address: 0x80002000, is64: true, lengthDw: 1,
    requester: 0x0000, tag: 1, dataDws: [0xdeadbeef],
  });
  const flit0 = buildFlit({ seq: 0, gen: 6, width, tlps: [t1, t2] });
  const flit1 = buildFlit({ seq: 1, gen: 6, width, tlps: [t1] });
  const flit2 = buildFlit({ seq: 2, gen: 6, width, payload: 'idle' });
  // Runtime packets belong to snapshot state; callbacks only capture stable sequence IDs.
  sim.scenarioState.flits = [flit0, flit1, flit2];

  function flitEvent(t, side, dir, flit, summary, detail, status = 'ok', before = null) {
    sim.at(t, () => {
      if (before) before();
      sim.emit({
        layer: 'FLIT', row: `${side}.FLIT`, side, dir, type: 'FLIT',
        summary, detail, packet: snapFlit(sim.scenarioState.flits[flit.seq]), dur_ns: flit.realTimeNs, status,
      });
    });
  }

  function fecEvent(t, flit, summary, detail, status = 'ok', before = null) {
    sim.at(t, () => {
      if (before) before();
      sim.emit({
        layer: 'FLIT', row: 'EP.FLIT', side: 'EP', dir: 'RX', type: 'FEC',
        summary, detail, packet: snapFlit(sim.scenarioState.flits[flit.seq]), status,
      });
    });
  }

  sim.at(0, () => {
    sim.beginPhase('flit-build', 'Flit 成帧与打包', 'bert',
      '256B Flit：TLP 区域 + DLP 6B + CRC 8B + FEC 6B');
    link.setBoth('L0', `RC / EP：L0（Gen6，64 GT/s，Flit Mode）`, 'Flit 模式下链路层以 256B Flit 为传输单元');
  });

  flitEvent(10 * US, 'RC', 'TX', flit0,
    `FLIT #0：${flit0.packed.length} 个 TLP，已用 ${flit0.payloadBytes}B / 填充 ${flit0.padding}B`,
    '两个 MWr 被打包进同一个 Flit；无 STP/END，本图按预设 TLP 数量展示，非标准 FM TLP/DLP 编码',
    'ok', () => {
      const c = checkFlit(sim.scenarioState.flits[0]);
      stats.onFlit(sim.scenarioState.flits[0], c);
    });
  flitEvent(12 * US, 'EP', 'RX', flit0, 'EP 接收 FLIT #0', 'FEC/CRC 处理流程示意（未执行真实算法）');
  fecEvent(22 * US, flit0, '示意：FEC 处理后 CRC 匹配',
    '预设正常结果：真实接收顺序为 FEC 解码/纠错后 CRC 校验；本模型不执行算法');

  sim.at(30 * US, () => sim.beginPhase('fec', 'FEC 纠错', 'fec',
    '三路交织、符号级纠错；本场景显式预设纠正或不可纠结果'));
  fecEvent(40 * US, flit0, '示意注入 2 bit：预设 FEC 已纠正、CRC 匹配',
    '预设纠正结果，不由 bit 数推导；实际取决于错误分组/位置与真实校验', 'ok', () => {
      const c = checkFlit(sim.scenarioState.flits[0], { bitErrors: 2, outcome: 'corrected' });
      stats.onFlit(sim.scenarioState.flits[0], c);
    });

  sim.at(54 * US, () => sim.beginPhase('retry', 'Flit 级重传', 'retry',
    '不可纠错误触发 Nak，RC 从重传缓冲重放 Flit'));
  flitEvent(60 * US, 'RC', 'TX', flit1,
    `FLIT #1：${flit1.packed.length} 个 TLP，已用 ${flit1.payloadBytes}B`,
    '单 TLP Flit', 'ok', () => {
      const c = checkFlit(sim.scenarioState.flits[1]);
      stats.onFlit(sim.scenarioState.flits[1], c);
    });
  flitEvent(62 * US, 'EP', 'RX', flit1, 'EP 接收 FLIT #1', 'FEC/CRC 处理流程示意（未执行真实算法）');

  fecEvent(76 * US, flit1, '示意注入 9 bit：预设不可纠、CRC 不匹配',
    '预设不可纠结果，不代表所有 9 bit 分布都不可纠；无效 Flit 进入重放流程', 'error', () => {
      const c = checkFlit(sim.scenarioState.flits[1], { bitErrors: 9, outcome: 'uncorrectable' });
      stats.onFlit(sim.scenarioState.flits[1], c);
    });

  sim.at(86 * US, () => sim.emit({
    layer: 'FLIT', row: 'EP.FLIT', side: 'EP', dir: 'TX', type: 'NAK',
    summary: 'EP → RC：Flit #1 Nak（请求重放）',
    detail: 'Flit 级 Nak 指向序号 #1，RC 从 Retry Buffer 重放', status: 'error',
  }));

  sim.at(96 * US, () => {
    stats.onRetry();
    sim.emit({
      layer: 'FLIT', row: 'RC.FLIT', side: 'RC', dir: 'TX', type: 'RETRY',
      summary: 'RC 重放 Flit #1（retry buffer）',
      detail: 'Flit 级重传：重放整个 256B Flit，而非单个 TLP', status: 'ok',
    });
  });
  flitEvent(100 * US, 'EP', 'RX', flit1, '示意：重放后预设 FEC/CRC 正常',
    '重放成功，链路继续', 'ok', () => {
      const c = checkFlit(sim.scenarioState.flits[1], { bitErrors: 0 });
      stats.onFlit(sim.scenarioState.flits[1], c);
    });

  sim.at(112 * US, () => sim.emit({
    layer: 'FLIT', row: 'STATE', side: 'RC', dir: '-', type: 'DONE',
    summary: 'Flit 级重传完成，链路继续工作',
    detail: `FEC 纠正 ${stats.corrected} 次，不可纠 ${stats.uncorrectable} 次，重传 ${stats.retries} 次`,
    status: 'ok',
  }));

  sim.at(120 * US, () => sim.beginPhase('done', '完成', 'flit',
    'Flit Mode 正常传输'));
  flitEvent(130 * US, 'RC', 'TX', flit2, 'FLIT #2：IDLE',
    '无 TLP 时发送 IDLE Flit，维持 Flit 边界与序号', 'ok', () => {
      const c = checkFlit(sim.scenarioState.flits[2]);
      stats.onFlit(sim.scenarioState.flits[2], c);
    });

  sim.at(150 * US, () => sim.endPhase());
  sim.durationNs = 164 * US;
  return {
    gen: 6,
    width,
    mode: 'flit',
    flitMode: true,
    durationNs: sim.durationNs,
    totalSteps: sim.pending,
    rows: sim.rows,
    defaultRow: null,
  };
}
