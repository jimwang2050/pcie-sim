import { resolveScenarioConfig } from './registry.js';
/**
 * 场景：MSI / MSI-X 中断。
 * 通过 Posted MWr 写入 RC 的 MSI 地址；MSI-X 每个表项有独立地址/数据/mask。
 */
import { buildMem } from '../core/tlp.js';
import {
  setupLinkL0, tlpPair, ackPair, US, EP_ID,
} from './mem_common.js';

export function buildMsiInt(sim, opts = {}) {
  resolveScenarioConfig('msi_int', opts);
  const gen = opts.gen ?? 3;
  const width = opts.width ?? 8;
  setupLinkL0(sim, gen, width, [
    { key: 'STATE', label: 'LTSSM 状态' },
    { key: 'RC.TL', label: 'RC · TL' },
    { key: 'RC.DLL', label: 'RC · DLL' },
    { key: 'EP.DLL', label: 'EP · DLL' },
    { key: 'EP.TL', label: 'EP · TL' },
  ]);

  const msi = sim.msi;
  msi.reset();
  const link = sim.link;

  sim.at(0, () => {
    sim.beginPhase('msi-config', 'MSI 配置', 'enum', '使能 MSI，配置消息地址与向量');
    link.setBoth('L0', 'RC / EP：L0（链路正常工作）', '中断演示前链路已训练完成');
  });
  sim.at(10 * US, () => {
    msi.enableMsi(4);
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'MSI',
      summary: 'MSI 使能：4 个向量，消息地址 0xFEE00000',
      detail: 'MSI 通过 Posted MWr 写入 RC 的 MSI 地址，Data 携带向量号', status: 'ok',
    });
  });

  function sendMsi(t, vector) {
    const pkt = buildMem({
      write: true, address: 0xFEE00000, is64: false, lengthDw: 1,
      requester: EP_ID, tag: vector, dataDws: [vector],
    });
    tlpPair(sim, t, 'EP', 'RC', pkt,
      `MSI MWr  Addr=0xFEE00000  Data=0x${vector.toString(16).padStart(8, '0')}  Vector=${vector}`,
      'MSI 中断消息（Posted MWr）', null, 'MSI');
    ackPair(sim, t + 4 * US, 'RC', 'EP', `MSI Vector=${vector}`);
    sim.at(t + 6 * US, () => {
      const ok = msi.trigger(vector);
      sim.emit({
        layer: 'STATE', row: 'STATE', type: 'INT',
        summary: ok ? `MSI Vector ${vector} → RC 触发中断` : `MSI Vector ${vector} 被屏蔽`,
        detail: 'MSI 地址匹配后，RC 将 Message Data 解释为向量号',
        status: ok ? 'ok' : 'idle',
      });
    });
  }

  sendMsi(20 * US, 0);
  sendMsi(50 * US, 1);
  sendMsi(80 * US, 2);

  function sendMsix(t, index) {
    const e = msi.msixTable[index];
    const pkt = buildMem({
      write: true, address: e.address, is64: false, lengthDw: 1,
      requester: EP_ID, tag: index, dataDws: [e.data],
    });
    tlpPair(sim, t, 'EP', 'RC', pkt,
      `MSI-X entry ${index}  Addr=0x${e.address.toString(16).toUpperCase()}  Data=0x${e.data.toString(16).toUpperCase()}`,
      'MSI-X 表项拥有独立地址/数据/mask', null, 'MSI-X');
    ackPair(sim, t + 4 * US, 'RC', 'EP', `MSI-X entry ${index}`);
    sim.at(t + 6 * US, () => {
      const ok = msi.triggerMsix(index);
      sim.emit({
        layer: 'STATE', row: 'STATE', type: 'INT',
        summary: ok ? `MSI-X entry ${index} → RC 触发中断` : `MSI-X entry ${index} 被 mask，无中断`,
        status: ok ? 'ok' : 'idle',
      });
    });
  }

  sim.at(110 * US, () => {
    sim.beginPhase('msix', 'MSI-X 中断', 'enum', 'MSI-X 表项：独立地址/数据/mask');
    msi.enableMsix();
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'MSI-X',
      summary: 'MSI-X 使能：4 个表项', detail: '每个表项有独立 Message Address/Data 与 Mask 位',
      status: 'ok',
    });
  });

  sendMsix(120 * US, 2);

  sim.at(150 * US, () => {
    msi.maskMsix(3, true);
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'MSI-X',
      summary: 'MSI-X entry 3 置 mask', detail: '被 mask 的表项即使触发也不会产生中断',
      status: 'ok',
    });
  });
  sendMsix(156 * US, 3);

  sim.at(180 * US, () => {
    msi.maskMsix(3, false);
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'MSI-X',
      summary: 'MSI-X entry 3 解除 mask', status: 'ok',
    });
  });
  sendMsix(186 * US, 3);

  sim.at(210 * US, () => sim.endPhase());
  sim.durationNs = 222 * US;
  return {
    gen,
    width,
    durationNs: sim.durationNs,
    totalSteps: sim.pending,
    rows: sim.rows,
    defaultRow: null,
  };
}
