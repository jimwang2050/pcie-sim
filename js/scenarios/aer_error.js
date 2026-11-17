import { resolveScenarioConfig } from './registry.js';
/**
 * 场景：AER 错误上报（Correctable / Non-Fatal / Fatal）+ Hot Reset 恢复。
 */
import { buildMsg } from '../core/tlp.js';
import {
  setupLinkL0, tlpPair, ackPair, US, EP_ID,
} from './mem_common.js';

export function buildAerError(sim, opts = {}) {
  resolveScenarioConfig('aer_error', opts);
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
  const aer = sim.aer;
  msi.reset();
  msi.enableMsi(4);
  aer.reset();
  aer.enable();
  const link = sim.link;

  sim.at(0, () => {
    sim.beginPhase('aer', 'AER 错误上报', 'enum',
      'Correctable / Uncorrectable Non-Fatal / Fatal 的检测与消息上报');
    link.setBoth('L0', 'RC / EP：L0（链路正常工作）', 'AER 已使能，错误将通过 Message TLP 上报');
  });

  function reportError(t, sev, code, label, detail) {
    const codeName = sev === 'cor' ? 'ERR_COR' : sev === 'nonfatal' ? 'ERR_NONFATAL' : 'ERR_FATAL';
    sim.at(t - 4 * US, () => {
      sim.emit({
        layer: 'DLL', row: 'EP.DLL', side: 'EP', dir: 'RX', type: 'ERROR',
        summary: `EP 检出错误：${label}`, detail, status: 'error',
      });
    });
    const pkt = buildMsg({ code, requester: EP_ID, tag: 0 });
    tlpPair(sim, t, 'EP', 'RC', pkt, `${codeName} 消息（${label}）`, detail, null, codeName);
    ackPair(sim, t + 4 * US, 'RC', 'EP', codeName);
    sim.at(t + 2 * US, () => aer.report(sev, label));
    sim.at(t + 6 * US, () => {
      const ok = msi.trigger(0);
      sim.emit({
        layer: 'TL', row: 'RC.TL', side: 'RC', dir: 'RX', type: 'INT',
        summary: `RC：${codeName} Message → MSI 写（Vector 0）`,
        detail: 'RC 把收到的错误 Message TLP 在内部转换为 MSI 内存写，交给主机中断控制器',
        status: ok ? 'ok' : 'idle',
      });
      sim.emit({
        layer: 'STATE', row: 'STATE', type: 'INT',
        summary: `${codeName} → 主机中断（MSI Vector 0）`,
        detail: ok
          ? 'AER 处理程序被唤醒并读 AER 状态寄存器；该中断由 RC 产生，不是 EP 发出的 MSI'
          : '中断被屏蔽，软件只能轮询 AER 状态寄存器',
        status: ok ? 'ok' : 'idle',
      });
    });
  }

  reportError(20 * US, 'cor', 0x30, 'Bad TLP（LCRC 错误）',
    'Correctable：LCRC 错误触发 Ack/Nak 重传');
  reportError(60 * US, 'nonfatal', 0x31, 'Unexpected Completion',
    'Uncorrectable Non-Fatal：收到无匹配请求的 Completion');
  reportError(100 * US, 'fatal', 0x33, 'Malformed TLP',
    'Uncorrectable Fatal：TLP 格式错误，链路可能不可用');

  sim.at(130 * US, () => {
    sim.beginPhase('reset', 'Hot Reset 恢复', 'loopback',
      '软件置 Bridge Control.Secondary Bus Reset，通过 TS1 Hot Reset 复位链路');
    link.setBoth('Hot Reset', 'RC / EP：Hot Reset', '链路进入带内复位');
  });
  sim.at(148 * US, () => {
    link.linkUp = false;
    link.setBoth('Detect.Quiet', 'RC / EP：回到 Detect', 'Hot Reset 完成后重新开始链路训练');
  });
  sim.at(164 * US, () => sim.endPhase());

  sim.durationNs = 178 * US;
  return {
    gen,
    width,
    durationNs: sim.durationNs,
    totalSteps: sim.pending,
    rows: sim.rows,
    defaultRow: null,
  };
}
