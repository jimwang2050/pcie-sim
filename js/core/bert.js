/**
 * BERT（Bit Error Rate Test）模型。
 * 支持 PRBS7/9/11/15/23/31 图案、锁定、累计比特/错误、误码注入与统计判定。
 *
 * 判定不是一个简单的 “errors == 0 → PASS”：
 *  - 未锁定 / 零样本 / 样本不足都不判 PASS；
 *  - 零错误时用单侧置信上界 1 − (1−confidence)^(1/n)；
 *  - 非零错误时用正态近似上界（教学近似，不作为合规判据）；
 *  - Gen6 是 PAM4/64 GT/s，目标用 FBER 1e-6，与低代际 BER 1e-12 分开。
 */
export const BERT_PATTERNS = {
  PRBS7: { polynomial: 'x^7 + x^6 + 1', order: 7, period: 127, note: '短序列，锁定快，适合近端 / 内部环回自检' },
  PRBS9: { polynomial: 'x^9 + x^5 + 1', order: 9, period: 511, note: '短序列，兼顾连续 0/1 与低频成分' },
  PRBS11: { polynomial: 'x^11 + x^9 + 1', order: 11, period: 2047, note: '中等序列，常用于 8b/10b 链路' },
  PRBS15: { polynomial: 'x^15 + x^14 + 1', order: 15, period: 32767, note: '中等序列，覆盖更长的连 0/1' },
  PRBS23: { polynomial: 'x^23 + x^18 + 1', order: 23, period: 8388607, note: '长序列，适合高速串行通道' },
  PRBS31: { polynomial: 'x^31 + x^28 + 1', order: 31, period: 2147483647, note: '最长标准序列，PCIe BERT 常用' },
};

export const BERT_PATTERN_ORDER = ['PRBS7', 'PRBS9', 'PRBS11', 'PRBS15', 'PRBS23', 'PRBS31'];

export const BERT_CONFIDENCE = 0.95;

/** 目标误码率：Gen6（PAM4，64 GT/s）用 FBER 1e-6；Gen1–5 用 BER 1e-12。 */
export const BERT_TARGETS = Object.freeze({ nrz: 1e-12, pam4Fber: 1e-6 });

export function targetFor(gen) {
  return gen >= 6 ? BERT_TARGETS.pam4Fber : BERT_TARGETS.nrz;
}

export function patternInfo(name) {
  return BERT_PATTERNS[name] || BERT_PATTERNS.PRBS31;
}

function zFor(confidence) {
  if (confidence >= 0.99) return 2.326;
  if (confidence >= 0.95) return 1.645;
  if (confidence >= 0.9) return 1.282;
  return 1.645;
}

/** 零错误时误码率的单侧上界：1 − (1−confidence)^(1/bits)。 */
export function zeroErrorUpperBound(bits, confidence = BERT_CONFIDENCE) {
  if (!(bits > 0) || !Number.isFinite(bits)) return Infinity;
  return 1 - Math.pow(1 - confidence, 1 / bits);
}

/** 达到目标所需的最小累计比特数（零错误、给定置信度）。 */
export function bitsForTarget(target, confidence = BERT_CONFIDENCE) {
  if (!(target > 0)) return Infinity;
  return Math.ceil(Math.log(1 - confidence) / Math.log(1 - target));
}

/** 非零错误时的上界：正态近似（教学近似）。 */
export function errorUpperBound(bits, errors, confidence = BERT_CONFIDENCE) {
  if (!(bits > 0)) return Infinity;
  const p = errors / bits;
  return p + zFor(confidence) * Math.sqrt(Math.max(p * (1 - p), 0) / bits);
}

/** 判定：DISABLED | NOT-LOCKED | NO-SAMPLE | INSUFFICIENT | PASS | FAIL。 */
export function bertVerdict({ enabled, locked, bits, errors, targetBer, confidence = BERT_CONFIDENCE }) {
  if (!enabled) return 'DISABLED';
  if (!locked) return 'NOT-LOCKED';
  if (!(bits > 0)) return 'NO-SAMPLE';
  if (errors === 0 && bits < bitsForTarget(targetBer, confidence)) return 'INSUFFICIENT';
  const upper = errors === 0
    ? zeroErrorUpperBound(bits, confidence)
    : errorUpperBound(bits, errors, confidence);
  return upper <= targetBer ? 'PASS' : 'FAIL';
}

export class BertModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.gen = 3;
    this.pattern = 'PRBS31';
    this.polynomial = BERT_PATTERNS.PRBS31.polynomial;
    this.locked = false;
    this.bits = 0;
    this.errors = 0;
    this.ber = 0;
    this.targetBer = targetFor(this.gen);
    this.confidence = BERT_CONFIDENCE;
    this.history = [];
    this.injections = [];
  }

  start(pattern = 'PRBS31') {
    this.enabled = true;
    this.pattern = BERT_PATTERNS[pattern] ? pattern : 'PRBS31';
    this.polynomial = patternInfo(this.pattern).polynomial;
    this.locked = false;
    this.injections = [];
    this.clear();
  }

  /** 速率代际决定判定目标（Gen6 用 PAM4 FBER）。 */
  setGen(gen) {
    this.gen = gen;
    this.targetBer = targetFor(gen);
  }

  lock() {
    this.locked = true;
  }

  clear() {
    this.bits = 0;
    this.errors = 0;
    this.ber = 0;
    this.history = [];
  }

  accumulate(bits, errors = 0) {
    this.bits += bits;
    this.errors += errors;
    this.ber = this.bits > 0 ? this.errors / this.bits : 0;
    this.history.push({ kind: 'measure', bits, errors, ber: this.ber, verdict: this.verdict });
    return this.ber;
  }

  inject(errors) {
    this.errors += errors;
    this.ber = this.bits > 0 ? this.errors / this.bits : 0;
    const rec = { kind: 'inject', bits: 0, errors, ber: this.ber, bitsAt: this.bits, verdict: this.verdict };
    this.history.push(rec);
    this.injections.push(rec);
    return this.ber;
  }

  get observedBer() {
    return this.bits > 0 ? this.errors / this.bits : 0;
  }

  get upperBound() {
    if (!(this.bits > 0)) return Infinity;
    return this.errors === 0
      ? zeroErrorUpperBound(this.bits, this.confidence)
      : errorUpperBound(this.bits, this.errors, this.confidence);
  }

  get verdict() {
    return bertVerdict({
      enabled: this.enabled,
      locked: this.locked,
      bits: this.bits,
      errors: this.errors,
      targetBer: this.targetBer,
      confidence: this.confidence,
    });
  }

  get pass() {
    return this.verdict === 'PASS';
  }

  get bitsNeeded() {
    return bitsForTarget(this.targetBer, this.confidence);
  }

  snapshot() {
    return {
      enabled: this.enabled,
      gen: this.gen,
      pattern: this.pattern,
      polynomial: this.polynomial,
      locked: this.locked,
      bits: this.bits,
      errors: this.errors,
      ber: this.observedBer,
      berUpper: this.upperBound,
      targetBer: this.targetBer,
      confidence: this.confidence,
      bitsNeeded: this.bitsNeeded,
      verdict: this.verdict,
      pass: this.pass,
      history: this.history.slice(),
      injections: this.injections.slice(),
    };
  }
}

export function formatBits(bits) {
  if (bits >= 1e12) return `${(bits / 1e12).toFixed(1)} Tb`;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gb`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} kb`;
  return `${bits} b`;
}
