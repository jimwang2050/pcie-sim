import { resolveScenarioConfig } from './registry.js';
/**
 * 场景：PHY 电气与均衡动态过程。
 *
 * REF CLK → PLL 锁定 → CDR（频率/相位/位锁定）→ L0
 * Gen3+ 再经过 Recovery.Speed + Equalization（Phase 0-3）收敛到目标速率。
 */
import { GEN_RATE, RATE_BY_GEN } from '../core/packet.js';
import { cdrText } from '../core/phy.js';

const US = 1000;

export function buildPhyLink(sim, opts = {}) {
  resolveScenarioConfig('phy_link', opts);
  const gen = opts.gen ?? 3;
  const width = opts.width ?? 8;
  const link = sim.link;
  const phy = sim.phy;
  // Gen6 为 PAM4 三 eye，眼高按单眼展示
  const eyeText = () => (phy.metrics.pam4
    ? `单眼 ${phy.metrics.eyeHeightPerEyeMv.toFixed(0)} mV ×3`
    : `眼高 ${phy.metrics.eyeHeightMv.toFixed(0)} mV`);

  link.configure({ gen, width, mode: 'auto' });
  link.reset();
  phy.reset(gen, width);
  phy.setOperatingRate(1);

  sim.rows = [
    { key: 'STATE', label: 'LTSSM 状态' },
    { key: 'RC.PHY', label: 'RC · PHY' },
    { key: 'EP.PHY', label: 'EP · PHY' },
  ];

  const at = (t, fn) => sim.at(t, fn);

  function state(t, st, summary, detail) {
    at(t, () => link.setBoth(st, summary, detail));
  }

  function phyEvent(t, side, type, summary, detail, mutate) {
    at(t, () => {
      if (mutate) mutate();
      phy.evaluate();
      sim.emit({
        layer: 'PHY',
        row: `${side}.PHY`,
        side,
        dir: '-',
        type,
        summary: typeof summary === 'function' ? summary() : summary,
        detail: typeof detail === 'function' ? detail() : detail,
        status: 'ok',
        dur_ns: 0,
      });
    });
  }

  // ---------- REF CLK / PLL ----------
  at(0, () => {
    sim.beginPhase('refclk', 'REF CLK / PLL', 'refclk',
      '100 MHz 差分参考时钟稳定后，PLL 倍频到链路速率');
    link.setBoth('Detect.Quiet', 'RC / EP：Detect.Quiet（等待参考时钟与 PLL 锁定）',
      'REF CLK 尚未稳定，发送端保持电气空闲');
  });
  phyEvent(8 * US, 'RC', 'REFCLK',
    'REF CLK 就绪：100 MHz，+120 ppm，SSC 开启',
    'SSC 用于降低 EMI；ppm 偏差需在 CDR 的牵引范围内', () => phy.stabilizeRefClk());
  phyEvent(22 * US, 'RC', 'PLL',
    `PLL 锁定：${GEN_RATE[gen]} GHz，jitter ${phy.pll.jitterPs} ps`,
    'PLL 将 100 MHz 参考时钟倍频到串行比特时钟', () => phy.lockPll());

  state(38 * US, 'Detect.Active', 'RC / EP：检测到接收器，进入 Detect.Active', 'REF CLK/PLL 已就绪');

  // ---------- CDR ----------
  at(60 * US, () => {
    sim.beginPhase('cdr', 'CDR 锁定', 'cdr',
      '接收端从数据跳变中恢复时钟：频率锁定 → 相位锁定 → 位锁定');
    link.setBoth('Polling.Active', 'RC / EP：Polling.Active', '发送 TS1/TS2，接收端 CDR 开始工作');
  });
  phyEvent(64 * US, 'EP', 'CDR', 'CDR 频率锁定（频偏 < 40 ppm）',
    'CDR 先匹配发送端比特速率，仍在滑动相位', () => phy.cdrFreqLock());
  phyEvent(88 * US, 'EP', 'CDR', 'CDR 相位锁定（相位误差 ≈ 12°）',
    '相位误差进入容限，开始可靠采样', () => phy.cdrPhaseLock());
  phyEvent(112 * US, 'EP', 'CDR', 'CDR 位锁定，眼图开始张开',
    `当前状态：${cdrText('BIT_LOCK')}`, () => phy.cdrBitLock());

  state(136 * US, 'Configuration.Idle', 'RC / EP：Configuration.Idle', 'CDR 已锁定，准备进入 L0');

  // ---------- 2.5 GT/s L0 ----------
  at(164 * US, () => {
    link.linkUp = true;
    link.setRate(1);
    phy.setOperatingRate(1);
    link.setBoth('L0', 'RC / EP：L0（2.5 GT/s）', '基础速率下链路已可工作');
    phy.evaluate();
    sim.emit({
      layer: 'PHY', row: 'RC.PHY', side: 'RC', dir: '-', type: 'COM',
      summary: `2.5 GT/s：COM ${phy.metrics.comDb.toFixed(1)} dB · ${eyeText()}`,
      detail: '基础速率信道损耗较低，COM 有较大裕量', status: 'ok',
    });
  });

  if (gen >= 3) {
    // ---------- Recovery.Speed ----------
    at(196 * US, () => {
      sim.beginPhase('speed', 'Recovery.Speed 变速', 'recovery',
        `PLL/CDR 切换到 ${RATE_BY_GEN[gen]}，随后进入 Equalization`);
      link.setBoth('Recovery.Speed', 'RC / EP：Recovery.Speed', 'PLL 重新锁定到目标速率');
    });
    phyEvent(202 * US, 'RC', 'PLL', `PLL 切换到 ${RATE_BY_GEN[gen]}`,
      `VCO 频段切换，jitter 仍为 ${phy.pll.jitterPs} ps`, () => phy.setOperatingRate(gen));
    phyEvent(216 * US, 'EP', 'CDR', 'CDR 重新频率锁定到目标速率',
      '更高速率下 CDR 需要重新牵引', () => phy.cdrFreqLock());
    phyEvent(230 * US, 'EP', 'CDR', 'CDR 相位/位锁定',
      '眼图在均衡前仍然闭合', () => phy.cdrBitLock());

    // ---------- Equalization ----------
    at(244 * US, () => {
      sim.beginPhase('eq', 'Recovery.Equalization', 'eq',
        'Phase 0-3：预设/系数扫描，使发送端 FFE 与信道匹配');
      link.setBoth('Recovery.Equalization', 'RC / EP：Recovery.Equalization', '开始均衡训练');
    });
    phyEvent(250 * US, 'RC', 'EQ',
      () => `Phase 0：预设扫描，初选 ${phy.eq.name}，COM ${phy.metrics.comDb.toFixed(1)} dB`,
      () => `preset ${phy.eq.name}：pre ${phy.eq.pre.toFixed(2)} / cursor ${phy.eq.cursor.toFixed(2)} / post ${phy.eq.post.toFixed(2)}`,
      () => phy.setEqPhase(0, 2));

    phyEvent(276 * US, 'RC', 'EQ',
      () => `Phase 1：FS/LF 调整，${phy.eq.name}，COM ${phy.metrics.comDb.toFixed(1)} dB`,
      '调整 Full Swing / Low Frequency，改善低频增益',
      () => phy.setEqPhase(1, 6));

    phyEvent(302 * US, 'RC', 'EQ',
      () => `Phase 2：pre-cursor 调整，${phy.eq.name}，COM ${phy.metrics.comDb.toFixed(1)} dB`,
      '增加 pre-cursor 以补偿信道前导 ISI',
      () => phy.setEqPhase(2, 8));

    phyEvent(328 * US, 'RC', 'EQ',
      () => `Phase 3：post-cursor 调整，收敛到 ${phy.eq.name}，COM ${phy.metrics.comDb.toFixed(1)} dB`,
      () => (gen === 6
        ? `PAM4 下使用 3-tap TX FFE + RX CTLE/DFE；系数 pre ${phy.eq.pre.toFixed(2)} / cursor ${phy.eq.cursor.toFixed(2)} / post ${phy.eq.post.toFixed(2)}`
        : `发送端 FFE 系数收敛：pre ${phy.eq.pre.toFixed(2)} / cursor ${phy.eq.cursor.toFixed(2)} / post ${phy.eq.post.toFixed(2)}`),
      () => phy.setEqPhase(3, phy.bestPreset()));

    at(352 * US, () => {
      link.linkUp = true;
      link.setRate(gen);
      link.negotiated = { gen, width };
      sim.beginPhase('l0', 'L0 正常工作', 'l0', `链路以 ${RATE_BY_GEN[gen]} × x${width} 工作`);
      link.setBoth('L0', `RC / EP：进入 L0（${RATE_BY_GEN[gen]}，x${width}）`,
        '均衡完成，链路稳定工作');
      phy.evaluate();
      sim.emit({
        layer: 'PHY', row: 'RC.PHY', side: 'RC', dir: '-', type: 'COM',
        summary: `均衡完成：COM ${phy.metrics.comDb.toFixed(1)} dB · ${eyeText()} · BER ${phy.metrics.ber.toExponential(1)}`,
        detail: `预加重/均衡增益 ${phy.eqGainDb.toFixed(1)} dB，CDR 惩罚 ${phy.cdrPenaltyDb} dB`,
        status: 'ok',
      });
    });

    at(378 * US, () => sim.endPhase());
    sim.durationNs = 392 * US;
  } else {
    at(196 * US, () => {
      link.linkUp = true;
      link.setRate(gen);
      link.negotiated = { gen, width };
      sim.beginPhase('l0', 'L0 正常工作', 'l0', `链路以 ${RATE_BY_GEN[gen]} × x${width} 工作`);
      link.setBoth('L0', `RC / EP：进入 L0（${RATE_BY_GEN[gen]}，x${width}）`,
        'Gen1/2 不使用发送均衡，CDR 锁定后直接进入 L0');
      phy.evaluate();
      sim.emit({
        layer: 'PHY', row: 'RC.PHY', side: 'RC', dir: '-', type: 'COM',
        summary: `COM ${phy.metrics.comDb.toFixed(1)} dB · ${eyeText()}`,
        detail: 'Gen1/2 无发送均衡，依靠固定去加重与 CDR', status: 'ok',
      });
    });
    at(222 * US, () => sim.endPhase());
    sim.durationNs = 236 * US;
  }

  return {
    gen,
    width,
    mode: link.flitMode ? 'flit' : 'nonflit',
    flitMode: link.flitMode,
    durationNs: sim.durationNs,
    totalSteps: sim.pending,
    rows: sim.rows,
    defaultRow: null,
  };
}
