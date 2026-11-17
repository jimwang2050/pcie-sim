/**
 * PCIe 流控信用模型（非 Flit 模式）。
 * 6 类信用：P/NP/Cpl × Hdr/Data；Data 信用以 16B 为单位。
 */
export const FC_CLASSES = ['P_Hdr', 'P_Data', 'NP_Hdr', 'NP_Data', 'Cpl_Hdr', 'Cpl_Data'];

export const FC_LABELS = {
  P_Hdr: 'P Hdr',
  P_Data: 'P Data',
  NP_Hdr: 'NP Hdr',
  NP_Data: 'NP Data',
  Cpl_Hdr: 'Cpl Hdr',
  Cpl_Data: 'Cpl Data',
};

function makeCredits(header, data, cplData) {
  return {
    P_Hdr: header,
    P_Data: data,
    NP_Hdr: header,
    NP_Data: data,
    Cpl_Hdr: header,
    Cpl_Data: cplData,
  };
}

export class FlowControl {
  constructor() {
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.initDone = false;
    this.limits = { RC: {}, EP: {} };
    this.available = { RC: {}, EP: {} };
    this.blocked = { RC: 0, EP: 0 };
    this.overReturned = { RC: 0, EP: 0 };
    this.lastBlock = null;
  }

  init({ header = 8, data = 32, cplData = 64 } = {}) {
    this.limits = {
      RC: makeCredits(header, data, cplData),
      EP: makeCredits(header, data, cplData),
    };
    this.available = {
      RC: makeCredits(header, data, cplData),
      EP: makeCredits(header, data, cplData),
    };
    this.enabled = true;
    this.initDone = false;
  }

  /** 检查一组信用能否原子满足；不改变状态。 */
  canSend(side, need = {}) {
    const a = this.available[side];
    if (!a) return false;
    return Object.entries(need).every(([cls, n]) => !(n > 0) || (a[cls] || 0) >= n);
  }

  /**
   * Header/Data 原子准入：要么全部扣减，要么一条都不扣。
   * 信用不足时不产生 TLP（由调用方决定阻塞/重试），也不出现负信用。
   */
  reserve(side, need = {}) {
    const a = this.available[side];
    if (!a) return { ok: false, missing: ['unknown'] };
    const missing = Object.entries(need)
      .filter(([cls, n]) => n > 0 && (a[cls] || 0) < n)
      .map(([cls]) => cls);
    if (missing.length) {
      this.blocked[side] = (this.blocked[side] || 0) + 1;
      this.lastBlock = { side, missing, need: { ...need } };
      return { ok: false, missing };
    }
    for (const [cls, n] of Object.entries(need)) if (n > 0) a[cls] -= n;
    return { ok: true, missing: [] };
  }

  /** 归还信用：不超过通告上限；超出部分单独计数，重复归还因此可见。 */
  release(side, credits = {}) {
    const a = this.available[side];
    const limit = this.limits[side];
    if (!a || !limit) return { ok: false, over: {} };
    const over = {};
    for (const [cls, n] of Object.entries(credits)) {
      if (!(n > 0)) continue;
      const next = (a[cls] || 0) + n;
      if (next > limit[cls]) {
        over[cls] = next - limit[cls];
        a[cls] = limit[cls];
      } else {
        a[cls] = next;
      }
    }
    if (Object.keys(over).length) this.overReturned[side] = (this.overReturned[side] || 0) + 1;
    return { ok: true, over };
  }

  /** 单类信用扣减（旧接口）：扣减失败时保持原值并计入阻塞。 */
  consume(side, cls, n = 1) {
    this.reserve(side, { [cls]: n });
    return this.available[side] ? (this.available[side][cls] || 0) : 0;
  }

  /** 单类信用归还（旧接口）。 */
  give(side, cls, n = 1) {
    this.release(side, { [cls]: n });
    return this.available[side] ? (this.available[side][cls] || 0) : 0;
  }

  static dataCredits(bytes) {
    return Math.ceil(bytes / 16);
  }

  snapshot() {
    return {
      enabled: this.enabled,
      initDone: this.initDone,
      limits: JSON.parse(JSON.stringify(this.limits)),
      available: JSON.parse(JSON.stringify(this.available)),
      blocked: { ...this.blocked },
      overReturned: { ...this.overReturned },
      lastBlock: this.lastBlock ? { ...this.lastBlock, missing: [...this.lastBlock.missing], need: { ...this.lastBlock.need } } : null,
    };
  }
}

/** 构造流控 DLLP（InitFC1 / InitFC2 / UpdateFC）。 */
export function buildFcDllp(name, credits) {
  const code = name === 'InitFC1' ? 0x40 : name === 'InitFC2' ? 0x48 : 0x80;
  const text = credits.map((c) => `${c.cls} H${c.hdr}/D${c.data}`).join(' · ');
  return {
    kind: 'DLLP',
    name,
    code,
    bytes: [code, 0x00, 0x00, 0x00, 0x00, 0x00],
    summary: `${name}  ${text}`,
    fields: [
      { name: 'DLLP Type', value: `0x${code.toString(16).toUpperCase()}`, display: name,
        desc: '流控初始化 / 信用更新 DLLP' },
      { name: 'VC', value: '0', display: 'VC0', desc: '虚拟通道 0' },
      { name: '信用', value: text, display: text, desc: 'Hdr / Data 信用（Data 以 16B 为单位）' },
      { name: 'CRC16', value: '0x0000', display: '占位', desc: '真实链路会附带 16bit DLLP CRC' },
    ],
  };
}
