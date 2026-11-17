/**
 * BERT（Bit Error Rate Test）模型。
 * 支持 PRBS7/9/11/15/23/31 图案、锁定、累计比特/错误、误码注入与 PASS/FAIL 判定。
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

export function patternInfo(name) {
  return BERT_PATTERNS[name] || BERT_PATTERNS.PRBS31;
}

export class BertModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.pattern = 'PRBS31';
    this.polynomial = BERT_PATTERNS.PRBS31.polynomial;
    this.locked = false;
    this.bits = 0;
    this.errors = 0;
    this.ber = 0;
    this.targetBer = 1e-12;
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
    this.history.push({ kind: 'measure', bits, errors, ber: this.ber });
    return this.ber;
  }

  inject(errors) {
    this.errors += errors;
    this.ber = this.bits > 0 ? this.errors / this.bits : 0;
    const rec = { kind: 'inject', bits: 0, errors, ber: this.ber, bitsAt: this.bits };
    this.history.push(rec);
    this.injections.push(rec);
    return this.ber;
  }

  get pass() {
    return this.locked && this.ber <= this.targetBer;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      pattern: this.pattern,
      polynomial: this.polynomial,
      locked: this.locked,
      bits: this.bits,
      errors: this.errors,
      ber: this.ber,
      targetBer: this.targetBer,
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
