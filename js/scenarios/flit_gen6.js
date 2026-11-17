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

  function flitEvent(t, side, dir, flit, summary, detail, status = 'ok', before = null) {
    sim.at(t, () => {
      if (before) before();
      sim.emit({
        layer: 'FLIT', row: `${side}.FLIT`, side, dir, type: 'FLIT',
        summary, detail, packet: snapFlit(flit), dur_ns: flit.realTimeNs, status,
      });
    });
  }

  function fecEvent(t, flit, summary, detail, status = 'ok', before = null) {
    sim.at(t, () => {
      if (before) before();
      sim.emit({
        layer: 'FLIT', row: 'EP.FLIT', side: 'EP', dir: 'RX', type: 'FEC',
        summary, detail, packet: snapFlit(flit), status,
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
    '两个 MWr 被打包进同一个 Flit；无 STP/END，按 DLP 中的 TLP 数量解析',
    'ok', () => {
      const c = checkFlit(flit0);
      stats.onFlit(flit0, c);
    });
  flitEvent(12 * US, 'EP', 'RX', flit0, 'EP 接收 FLIT #0', 'FEC/CRC 待校验');
  fecEvent(22 * US, flit0, 'FEC 3 组通过，CRC OK',
    '无错误：FEC 校验一致，双份 CRC-32 匹配');

  sim.at(30 * US, () => sim.beginPhase('fec', 'FEC 纠错', 'fec',
    'FEC 可纠正 ≤2 bit；超过则 CRC 失败'));
  fecEvent(40 * US, flit0, '注入 2 bit 错误 → FEC 纠正，CRC 通过',
    'FEC 组内纠正后 CRC 仍匹配，Flit 无需重传', 'ok', () => {
      const c = checkFlit(flit0, { bitErrors: 2 });
      stats.onFlit(flit0, c);
    });

  sim.at(54 * US, () => sim.beginPhase('retry', 'Flit 级重传', 'retry',
    '不可纠错误触发 Nak，RC 从重传缓冲重放 Flit'));
  flitEvent(60 * US, 'RC', 'TX', flit1,
    `FLIT #1：${flit1.packed.length} 个 TLP，已用 ${flit1.payloadBytes}B`,
    '单 TLP Flit', 'ok', () => {
      const c = checkFlit(flit1);
      stats.onFlit(flit1, c);
    });
  flitEvent(62 * US, 'EP', 'RX', flit1, 'EP 接收 FLIT #1', 'FEC/CRC 待校验');

  fecEvent(76 * US, flit1, 'FEC 不可纠（9 bit），CRC 失败',
    '错误超过 FEC 纠正能力，Flit 被标记为无效', 'error', () => {
      const c = checkFlit(flit1, { bitErrors: 9 });
      stats.onFlit(flit1, c);
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
  flitEvent(100 * US, 'EP', 'RX', flit1, 'EP 重新接收 Flit #1：FEC/CRC 通过',
    '重放成功，链路继续', 'ok', () => {
      const c = checkFlit(flit1, { bitErrors: 0 });
      stats.onFlit(flit1, c);
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
      const c = checkFlit(flit2);
      stats.onFlit(flit2, c);
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
