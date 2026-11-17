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

  /** 发送端消耗信用（side = 发送方）。 */
  consume(side, cls, n = 1) {
    const a = this.available[side];
    if (!a) return 0;
    a[cls] = Math.max(0, (a[cls] || 0) - n);
    return a[cls];
  }

  /** 接收端通过 UpdateFC 归还信用（side = 发送方）。 */
  give(side, cls, n = 1) {
    const a = this.available[side];
    if (!a) return 0;
    a[cls] = Math.min(this.limits[side][cls], (a[cls] || 0) + n);
    return a[cls];
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
