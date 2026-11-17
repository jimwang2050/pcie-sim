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
      '检出即记录 Status；消息是否发出由 Mask 与 Severity 决定，主机中断由 RC 产生');
    link.setBoth('L0', 'RC / EP：L0（链路正常工作）', 'AER 已使能，错误将按严重级别上报');
  });

  // 构建期镜像：预判每一步该不该发消息，运行时由 AerModel 记录真实计数。
  const plan = {
    mask: { cor: false, nonfatal: false, fatal: false },
    severity: { cor: 'cor', nonfatal: 'nonfatal', fatal: 'fatal' },
  };
  const CODE = { cor: 0x30, nonfatal: 0x31, fatal: 0x33 };
  const NAME = { cor: 'ERR_COR', nonfatal: 'ERR_NONFATAL', fatal: 'ERR_FATAL' };

  function setMask(t, severity, masked) {
    sim.at(t, () => aer.setMask(severity, masked));
    plan.mask[severity] = masked;
  }

  function setSeverity(t, severity, effective) {
    sim.at(t, () => aer.setSeverity(severity, effective));
    plan.severity[severity] = effective;
  }

  function reportError(t, sev, label, detail) {
    const effective = plan.severity[sev];
    const codeName = NAME[effective];
    sim.at(t - 4 * US, () => {
      sim.emit({
        layer: 'DLL', row: 'EP.DLL', side: 'EP', dir: 'RX', type: 'ERROR',
        summary: `EP 检出错误：${label}`, detail, status: 'error',
      });
      aer.report(sev, label);
    });
    if (plan.mask[effective]) {
      sim.at(t, () => {
        sim.emit({
          layer: 'TL', row: 'RC.TL', side: 'RC', dir: '-', type: 'AER',
          summary: `${codeName} 消息被 Mask：只在 Status/日志中记录`,
          detail: 'Mask 抑制的是消息上报，不表示错误没有发生；软件读 AER 状态仍能看到',
          status: 'idle',
        });
        sim.emit({
          layer: 'STATE', row: 'STATE', type: 'INT',
          summary: '没有错误消息 → 也没有对应主机中断',
          detail: '未解除 Mask 前，主机只能轮询 AER 状态寄存器', status: 'idle',
        });
      });
      return;
    }
    const pkt = buildMsg({ code: CODE[effective], requester: EP_ID, tag: 0 });
    tlpPair(sim, t, 'EP', 'RC', pkt, `${codeName} 消息（${label}）`, detail, null, codeName);
    ackPair(sim, t + 4 * US, 'RC', 'EP', codeName);
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

  reportError(20 * US, 'cor', 'Bad TLP（LCRC 错误）',
    'Correctable：LCRC 错误触发 Ack/Nak 重传');
  setMask(52 * US, 'nonfatal', true);
  reportError(60 * US, 'nonfatal', 'Unexpected Completion',
    'Uncorrectable Non-Fatal：收到无匹配请求的 Completion；此处 Mask=1');
  setMask(88 * US, 'nonfatal', false);
  setSeverity(92 * US, 'nonfatal', 'fatal');
  reportError(100 * US, 'nonfatal', 'Malformed TLP',
    '检出为 Uncorrectable Non-Fatal，但 Severity 配置为 Fatal → 上报 ERR_FATAL');

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
