/**
 * 电源管理三层模型：D（软件可见）/ L（由 D + ASPM 推导）/ P（PHY 侧 PIPE PowerDown 编码）。
 *
 * D 状态由 PM 软件通过 PMCSR.PowerState 控制，软件可见；
 * L 状态由 D 状态与 ASPM 推导，LTSSM 执行，软件通常不可见；
 * P 状态是 PHY/PIPE 的 powerdown 编码，由 PHY 实现，不能与 L1 / L2 画等号。
 */
export const P_STATES = [
  { name: 'P0', pipe: '00', pll: '开', clk: 'PCLK 有效', powerW: 10 },
  { name: 'P1', pipe: '01', pll: '开（门控）', clk: '按实现门控', powerW: 6 },
  { name: 'P2', pipe: '10', pll: '关断', clk: '关闭', powerW: 3 },
];

export const D_STATE_INFO = {
  D0: { name: 'D0', link: 'L0 / L0s / L0p / L1', desc: '全功能；D0 期间链路可由 ASPM 进出 L0s / L0p / L1' },
  D1: { name: 'D1', link: 'L1（ASPM / 软件策略）', powerW: 1.5, desc: '轻睡眠；配置空间可访问，需软件恢复上下文' },
  D2: { name: 'D2', link: 'L1', powerW: 0.8, desc: '深睡眠；更多上下文丢失' },
  D3hot: { name: 'D3hot', link: 'L1 / L2/L3 Ready（≠ L3）', powerW: 0.3, desc: '软件可写 PMCSR 唤醒；Vcc 仍在，LTSSM 仍供电' },
  D3cold: { name: 'D3cold', link: 'L2 / L3（LTSSM 断电）', powerW: 0, desc: 'Vcc 移除；L3 时 LTSSM 已断电，必须上电复位才能回 D0' },
};

export const D_CODE = { D0: 0, D1: 1, D2: 2, D3hot: 3 };
export const CODE_D = ['D0', 'D1', 'D2', 'D3hot'];

export const PMCSR_BITS = [
  { bit: 0, name: 'PowerState[0]', desc: 'D 状态编码 bit0' },
  { bit: 1, name: 'PowerState[1]', desc: 'D 状态编码 bit1（00=D0, 01=D1, 10=D2, 11=D3hot）' },
  { bit: 3, name: 'No_Soft_Reset', desc: 'D3hot→D0 时不要求软件重新初始化' },
  { bit: 8, name: 'PME_En', desc: '允许设备发出 PME' },
  { bit: 15, name: 'PME_Status', desc: 'PME 挂起（RW1C，写 1 清除）' },
];

export class PmModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.dstate = 'D0';
    this.pstate = 0;
    this.pmeEn = false;
    this.pmeStatus = false;
    this.noSoftReset = false;
    this.auxPower = true;
    this.linkState = 'L0';
    this.l1Sub = 'L1.0';
  }

  enable() {
    this.enabled = true;
  }

  get powerW() {
    if (this.dstate === 'D3cold') return 0;
    if (this.dstate === 'D3hot') return D_STATE_INFO.D3hot.powerW;
    if (this.dstate === 'D2') return D_STATE_INFO.D2.powerW;
    if (this.dstate === 'D1') return D_STATE_INFO.D1.powerW;
    return P_STATES[this.pstate].powerW;
  }

  get pmcsr() {
    let v = D_CODE[this.dstate] ?? 0;
    if (this.noSoftReset) v |= 0x8;
    if (this.pmeEn) v |= 0x100;
    if (this.pmeStatus) v |= 0x8000;
    return v;
  }

  setDState(d) {
    if (!D_STATE_INFO[d]) return;
    this.dstate = d;
    this.linkState = d === 'D0' ? 'L0' : (d === 'D3cold' ? 'OFF' : 'L1');
    if (this.linkState === 'L1') this.l1Sub = 'L1.0';
    if (d !== 'D0') this.pstate = 0;
  }

  /** L1 PM Substates：L1.0 / L1.1 / L1.2。 */
  setL1Sub(sub) {
    if (!['L1.0', 'L1.1', 'L1.2'].includes(sub)) return;
    this.l1Sub = sub;
  }

  /** 写 PMCSR（PowerState / PME_En / No_Soft_Reset / PME_Status RW1C）。 */
  writePmcsr(value) {
    const v = value & 0xffff;
    this.noSoftReset = (v & 0x8) !== 0;
    this.pmeEn = (v & 0x100) !== 0;
    if (v & 0x8000) this.pmeStatus = false;
    this.setDState(CODE_D[v & 0x3]);
  }

  setPState(index) {
    if (this.dstate !== 'D0') return false;
    this.pstate = Math.max(0, Math.min(P_STATES.length - 1, index));
    return true;
  }

  triggerPme() {
    if (!this.pmeEn) return false;
    if (!['D1', 'D2', 'D3hot'].includes(this.dstate)) return false;
    this.pmeStatus = true;
    return true;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      dstate: this.dstate,
      pstate: this.pstate,
      pstateName: P_STATES[this.pstate].name,
      powerW: this.powerW,
      pmcsr: this.pmcsr,
      pmeEn: this.pmeEn,
      pmeStatus: this.pmeStatus,
      noSoftReset: this.noSoftReset,
      auxPower: this.auxPower,
      linkState: this.linkState,
      l1Sub: this.l1Sub,
      pStates: P_STATES.map((p) => ({ ...p })),
      dStates: Object.values(D_STATE_INFO).map((d) => ({ ...d })),
    };
  }
}
