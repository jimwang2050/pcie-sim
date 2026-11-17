/**
 * 链路模型：两端口的 LTSSM 状态、训练参数与协商结果。
 * M1 只实现与链路训练相关的状态；TLP/DLLP 状态在 M2/M3 追加。
 */
import { GEN_RATE, RATE_BY_GEN, encodingOf, dataRateGBs } from './packet.js';

export const LINK_WIDTHS = Object.freeze([1, 2, 4, 8, 16]);

export const LTSSM_TOP = [
  { key: 'Detect', cn: '检测', desc: '电气检测链路远端是否存在接收器' },
  { key: 'Polling', cn: '轮询', desc: 'TS1/TS2 建立位锁与符号/块锁' },
  { key: 'Configuration', cn: '配置', desc: '协商链路宽度、通道编号与链路编号' },
  { key: 'L0', cn: '正常工作', desc: 'TLP、DLLP 与有序集正常交换' },
  { key: 'Recovery', cn: '重训练', desc: '速率/宽度变更或错误后的重新训练' },
  { key: 'L0s', cn: '低功耗 L0s', desc: 'ASPM 快速低功耗状态' },
  { key: 'L1', cn: '低功耗 L1', desc: '更深的 ASPM/PM 低功耗状态' },
  { key: 'L2', cn: '低功耗 L2', desc: '主电源关闭，仅 Vaux 可用' },
  { key: 'Hot Reset', cn: '热复位', desc: '带内复位链路' },
  { key: 'Loopback', cn: '环回', desc: '测试用环回状态' },
  { key: 'Disable', cn: '禁用', desc: '链路被软件禁用' },
];

function createPort(side) {
  return {
    side,
    state: 'Detect.Quiet',
    top: 'Detect',
    sub: 'Quiet',
    linkNumber: 0,
    laneNumbers: [],
    nFts: 4,
    rateGen: 1,
    counters: { ts1: 0, ts2: 0, skp: 0 },
    detected: false,
  };
}

export class LinkModel {
  constructor(sim) {
    this.sim = sim;
    this.gen = 3;
    this.width = 8;
    this.targetGen = 3;
    this.ports = { RC: createPort('RC'), EP: createPort('EP') };
    this.negotiated = { gen: 1, width: 8 };
    this.linkUp = false;
    this.flitMode = false;
    this.modeRequested = 'auto';
    this.modeNote = '';
  }

  configure({ gen = 3, width = 8, mode = 'auto' }) {
    if (![1, 2, 3, 4, 5, 6].includes(gen) || !LINK_WIDTHS.includes(width) || !['auto', 'flit', 'nonflit'].includes(mode)) throw new RangeError('无效链路配置');
    if (gen === 6 && mode === 'nonflit') throw new RangeError('64 GT/s 必须使用 Flit');
    this.targetGen = gen;
    this.gen = gen;
    this.width = width;
    this.modeRequested = mode;
    const requested = mode === 'auto' ? (gen === 6 ? 'flit' : 'nonflit') : mode;
    this.flitMode = gen === 6 ? true : requested === 'flit';
    this.modeNote = gen === 6 && requested === 'nonflit' ? 'Gen6 强制使用 Flit 模式' : '';
    this.negotiated = { gen: 1, width };
  }

  reset() {
    this.ports = { RC: createPort('RC'), EP: createPort('EP') };
    this.linkUp = false;
    this.negotiated = { gen: 1, width: this.width };
    for (const side of ['RC', 'EP']) {
      const p = this.ports[side];
      p.nFts = this.gen <= 2 ? 4 : 12;
      p.rateGen = 1;
    }
  }

  get currentRateName() {
    return RATE_BY_GEN[this.ports.RC.rateGen] ?? RATE_BY_GEN[1];
  }

  get currentRateGBs() {
    return dataRateGBs(this.gen, this.width);
  }

  /** 同时设置两个端口的状态，并产生一条 STATE 事件。 */
  setBoth(state, summary, detail = '') {
    for (const side of ['RC', 'EP']) {
      const p = this.ports[side];
      p.state = state;
      p.top = state.split('.')[0];
      p.sub = state.includes('.') ? state.slice(state.indexOf('.') + 1) : '';
    }
    this.sim.emit({
      layer: 'STATE',
      row: 'STATE',
      side: null,
      dir: '-',
      type: 'LTSSM',
      summary,
      detail,
      state,
      status: 'ok',
      dur_ns: 0,
    });
  }

  /** 设置链路当前工作速率（内部用于展示，不再编码进 TS 字段的 4bit 码）。 */
  setRate(gen) {
    for (const side of ['RC', 'EP']) this.ports[side].rateGen = gen;
  }

  setLaneNumbers(nums) {
    for (const side of ['RC', 'EP']) this.ports[side].laneNumbers = nums.slice();
  }

  bump(side, kind) {
    const c = this.ports[side].counters;
    if (kind === 'TS1') c.ts1 += 1;
    else if (kind === 'TS2') c.ts2 += 1;
    else if (kind === 'SKP') c.skp += 1;
  }

  /** 用于界面展示的摘要。 */
  snapshot() {
    return {
      gen: this.targetGen,
      width: this.width,
      encoding: encodingOf(this.targetGen),
      rate: this.currentRateName,
      rateGBs: this.currentRateGBs,
      linkUp: this.linkUp,
      flitMode: this.flitMode,
      modeNote: this.modeNote,
      ports: {
        RC: { ...this.ports.RC, counters: { ...this.ports.RC.counters } },
        EP: { ...this.ports.EP, counters: { ...this.ports.EP.counters } },
      },
      negotiated: { ...this.negotiated },
    };
  }
}

export { GEN_RATE, RATE_BY_GEN, encodingOf };
