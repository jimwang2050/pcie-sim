/**
 * PHY 电气层简化动态模型：REF CLK / PLL / CDR / EQ / 链路预算（COM）。
 *
 * EQ 模型：
 *  - 信道：3 抽头脉冲响应（pre-ISI / main / post-ISI），随代际损耗增大
 *  - TX：3 抽头 FFE（pre-cursor / cursor / post-cursor），使用 PCIe Gen3 预设 P0–P10
 *  - RX：CTLE 增益 + DFE 抽头，削减残余 ISI
 *  - 预设扫描：Phase 0 选择使均衡后眼开度最大的 preset
 *
 * 注意：COM、眼图与 BER 为教学估算，用于展示趋势与各阶段影响，
 * 不等同于 IEEE 802.3 / PCIe 规范中的完整 COM 算法。
 */
import { GEN_RATE } from './packet.js';

export const PHY_CHANNEL_LOSS = { 1: 8, 2: 12, 3: 18, 4: 24, 5: 30, 6: 36 };
export const COM_PASS_DB = 3;

/** 各代际的接收端均衡配置（与 PhyModel 共用，供代际对照表展示）。 */
export const RX_EQ_BY_GEN = {
  1: { ctleDb: 0, dfeTaps: 0 },
  2: { ctleDb: 0, dfeTaps: 0 },
  3: { ctleDb: 3, dfeTaps: 0 },
  4: { ctleDb: 5, dfeTaps: 1 },
  5: { ctleDb: 6, dfeTaps: 2 },
  6: { ctleDb: 7, dfeTaps: 2 },
};

/** PCIe Gen3 3 抽头 TX FFE 预设（归一化：pre + cursor + post = 1）。 */
export const EQ_PRESETS = [
  { name: 'P0', pre: 0.0, cursor: 1.0, post: 0.0 },
  { name: 'P1', pre: 0.0, cursor: 0.9, post: 0.1 },
  { name: 'P2', pre: 0.0, cursor: 0.8, post: 0.2 },
  { name: 'P3', pre: 0.0, cursor: 0.7, post: 0.3 },
  { name: 'P4', pre: 0.1, cursor: 0.7, post: 0.2 },
  { name: 'P5', pre: 0.1, cursor: 0.6, post: 0.3 },
  { name: 'P6', pre: 0.1, cursor: 0.5, post: 0.4 },
  { name: 'P7', pre: 0.2, cursor: 0.5, post: 0.3 },
  { name: 'P8', pre: 0.2, cursor: 0.4, post: 0.4 },
  { name: 'P9', pre: 0.3, cursor: 0.4, post: 0.3 },
  { name: 'P10', pre: 0.3, cursor: 0.3, post: 0.4 },
];

const TX_DB = 30;
const NOISE_DB = 8;
const PRE_MAX = 0.35;
const POST_MAX = 0.45;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function isiForLoss(lossDb) {
  return {
    preIsi: 0.05 + lossDb / 120,
    postIsi: 0.10 + lossDb / 90,
  };
}

export class PhyModel {
  constructor() {
    this.reset(3, 8);
  }

  reset(gen = 3, width = 8) {
    this.gen = gen;
    this.width = width;
    this.activeGen = gen;
    this.rateGts = GEN_RATE[gen] ?? 8;
    // Gen6 64 GT/s 使用 PAM4（4 电平 → 上/中/下三个眼）
    this.pam4 = gen === 6;
    this.refClk = { freqMHz: 100, ppm: 120, ssc: true, stable: false };
    this.pll = { locked: false, freqGHz: 0, jitterPs: 0.35 };
    this.cdr = { state: 'UNLOCKED', freqErrorPpm: 300, phaseErrorDeg: 180 };

    const loss = PHY_CHANNEL_LOSS[gen] ?? 18;
    const isi = isiForLoss(loss);
    this.channel = {
      lossDb: loss,
      crosstalkDb: 2,
      reflectionDb: 1.5,
      preIsi: isi.preIsi,
      postIsi: isi.postIsi,
    };
    this.rxEq = { ...(RX_EQ_BY_GEN[gen] ?? RX_EQ_BY_GEN[3]) };
    this.fec = gen === 6;
    this.eq = {
      phase: 0,
      presetIndex: 0,
      name: 'P0',
      pre: 0,
      cursor: 1,
      post: 0,
      fs: 0,
      lf: 0,
      converged: false,
      eyeOpening: 1,
    };
    this.applyPreset(0);
  }

  get rxEqEff() {
    return clamp(this.rxEq.ctleDb / 20 + this.rxEq.dfeTaps * 0.05, 0, 0.55);
  }

  get cdrPenaltyDb() {
    if (this.cdr.state === 'BIT_LOCK') return 0;
    if (this.cdr.state === 'PHASE_LOCK') return 2;
    if (this.cdr.state === 'FREQ_LOCK') return 4;
    return 6;
  }

  get cdrEyeFactor() {
    if (this.cdr.state === 'BIT_LOCK') return 1;
    if (this.cdr.state === 'PHASE_LOCK') return 0.7;
    if (this.cdr.state === 'FREQ_LOCK') return 0.45;
    return 0.25;
  }

  get fecGainDb() {
    return this.fec ? 3 : 0;
  }

  /** 均衡后相对 P0 的改善量（dB），用于链路预算展示。 */
  get eqGainDb() {
    const base = this.eyeForPreset(0);
    return Math.max(0, 20 * Math.log10(Math.max(1e-3, this.eq.eyeOpening / base)));
  }

  stabilizeRefClk() {
    this.refClk.stable = true;
    this.evaluate();
  }

  lockPll() {
    this.pll.locked = true;
    this.pll.freqGHz = this.rateGts;
    this.evaluate();
  }

  /** 切换当前工作速率（影响信道损耗、ISI 与 UI）。 */
  setOperatingRate(gen) {
    this.activeGen = gen;
    this.pam4 = gen === 6;
    this.rateGts = GEN_RATE[gen] ?? this.rateGts;
    const loss = PHY_CHANNEL_LOSS[gen] ?? this.channel.lossDb;
    this.channel.lossDb = loss;
    const isi = isiForLoss(loss);
    this.channel.preIsi = isi.preIsi;
    this.channel.postIsi = isi.postIsi;
    this.pll.freqGHz = this.rateGts;
    this.eq.eyeOpening = this.eyeForPreset(this.eq.presetIndex);
    this.evaluate();
  }

  cdrFreqLock() {
    this.cdr.state = 'FREQ_LOCK';
    this.cdr.freqErrorPpm = 40;
    this.evaluate();
  }

  cdrPhaseLock() {
    this.cdr.state = 'PHASE_LOCK';
    this.cdr.phaseErrorDeg = 12;
    this.evaluate();
  }

  cdrBitLock() {
    this.cdr.state = 'BIT_LOCK';
    this.cdr.phaseErrorDeg = 2;
    this.evaluate();
  }

  /** 给定 preset 的均衡后眼开度（0-1）。 */
  eyeForPreset(index) {
    const p = EQ_PRESETS[clamp(index, 0, EQ_PRESETS.length - 1)];
    const preRes = this.channel.preIsi * Math.max(0, 1 - p.pre / PRE_MAX);
    const postRes = this.channel.postIsi * Math.max(0, 1 - p.post / POST_MAX);
    const residual = (preRes + postRes) * (1 - this.rxEqEff);
    const cursorPenalty = (1 - p.cursor) * 0.3;
    return clamp(1 - residual - cursorPenalty, 0.02, 1);
  }

  /** 扫描所有 preset，返回眼开度最大的下标。 */
  bestPreset() {
    let best = 0;
    let bestEye = -1;
    for (let i = 0; i < EQ_PRESETS.length; i += 1) {
      const eye = this.eyeForPreset(i);
      if (eye > bestEye) {
        bestEye = eye;
        best = i;
      }
    }
    return best;
  }

  /** 各 preset 的均衡后眼开度（0-1），供模型视图展示。 */
  presetEyes() {
    return EQ_PRESETS.map((_, i) => this.eyeForPreset(i));
  }

  applyPreset(index) {
    const idx = clamp(index, 0, EQ_PRESETS.length - 1);
    const p = EQ_PRESETS[idx];
    this.eq.presetIndex = idx;
    this.eq.name = p.name;
    this.eq.pre = p.pre;
    this.eq.cursor = p.cursor;
    this.eq.post = p.post;
    this.eq.fs = Math.min(7, Math.round(p.cursor * 7));
    this.eq.lf = Math.min(7, Math.round((p.cursor + p.pre) * 7));
    this.eq.eyeOpening = this.eyeForPreset(idx);
    this.evaluate();
  }

  /**
   * 推进 Equalization 阶段。
   * phase 0 初选 preset，phase 3 收敛到最佳 preset。
   */
  setEqPhase(phase, presetIndex = null) {
    this.eq.phase = phase;
    let idx = presetIndex;
    if (idx === null || idx === undefined) {
      if (phase === 0) idx = 2;
      else if (phase >= 3) idx = this.bestPreset();
      else idx = this.eq.presetIndex;
    }
    this.applyPreset(idx);
    this.eq.phase = phase;
    this.eq.converged = phase >= 3;
    this.evaluate();
  }

  evaluate() {
    const eyeOpening = clamp(this.eq.eyeOpening ?? 1, 0.01, 1);
    const eyeEff = clamp(eyeOpening * this.cdrEyeFactor, 0.01, 1);
    const comDb = 20 * Math.log10(eyeOpening) + 10 + this.fecGainDb - this.cdrPenaltyDb;

    const eyeFactor = clamp((eyeEff - 0.05) / 0.75, 0.04, 1);
    const uiPs = 1000 / this.rateGts;
    const eyeHeightMv = 60 + 760 * eyeFactor;
    const eyeWidthPs = uiPs * (0.2 + 0.65 * eyeFactor);
    const ber = Math.min(0.5, Math.pow(10, -(comDb / 1.8 + 2)));
    const pam4 = this.activeGen === 6;

    this.metrics = {
      comDb,
      comPass: comDb >= COM_PASS_DB,
      eyeHeightMv,
      eyeWidthPs,
      uiPs,
      ber,
      eyeOpening,
      eyeEff,
      pam4,
      eyeCount: pam4 ? 3 : 1,
      // PAM4 4 电平，单眼高度约为 NRZ 等效摆幅的 1/3
      eyeHeightPerEyeMv: pam4 ? eyeHeightMv / 3 : eyeHeightMv,
      modulation: pam4 ? 'PAM4' : 'NRZ',
    };
  }

  snapshot() {
    return {
      gen: this.gen,
      activeGen: this.activeGen,
      width: this.width,
      rateGts: this.rateGts,
      pam4: this.pam4,
      refClk: { ...this.refClk },
      pll: { ...this.pll },
      cdr: { ...this.cdr },
      eq: { ...this.eq },
      channel: { ...this.channel },
      rxEq: { ...this.rxEq, eff: this.rxEqEff },
      metrics: { ...this.metrics },
      eqGainDb: this.eqGainDb,
      cdrPenaltyDb: this.cdrPenaltyDb,
      fecGainDb: this.fecGainDb,
      txDb: TX_DB,
      noiseDb: NOISE_DB,
      presets: EQ_PRESETS,
      presetEyes: this.presetEyes(),
      bestPreset: this.bestPreset(),
    };
  }
}

export function cdrText(state) {
  return {
    UNLOCKED: '未锁定',
    FREQ_LOCK: '频率锁定',
    PHASE_LOCK: '相位锁定',
    BIT_LOCK: '位锁定',
  }[state] || state;
}

export function formatBer(ber) {
  if (ber <= 0) return '0';
  if (ber < 1e-3) return ber.toExponential(1);
  return ber.toFixed(3);
}
