/**
 * Loopback 模型：区分内部环回与外部环回。
 *
 * internal：TX 在器件内部直接回送到 RX（近端 / 数字环回），不经过封装、通道与连接器，
 *           用于 SerDes / PLL / CDR 自检，不能证明链路可用。
 * external：回环点在对端（Loopback Slave）或环回插头，数据经通道往返，
 *           覆盖封装、PCB、连接器与线缆损耗，是链路电气验证的主力。
 */
export class LoopbackModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.mode = 'none';
    this.master = 'RC';
    this.slave = '-';
    this.channelLossDb = 0;
    this.internalErrors = 0;
    this.externalErrors = 0;
    this.pattern = '';
  }

  enter(mode, pattern = '') {
    if (mode !== 'internal' && mode !== 'external') return false;
    this.mode = mode;
    this.master = 'RC';
    this.slave = mode === 'internal' ? 'self' : 'EP';
    this.channelLossDb = mode === 'internal' ? 0 : 12;
    this.pattern = pattern;
    return true;
  }

  /** 记录某个环回模式下的误码。 */
  addErrors(n) {
    if (this.mode === 'internal') this.internalErrors += n;
    else if (this.mode === 'external') this.externalErrors += n;
  }

  exit() {
    const prev = this.mode;
    this.mode = 'none';
    this.slave = '-';
    this.channelLossDb = 0;
    return prev;
  }

  snapshot() {
    return {
      mode: this.mode,
      master: this.master,
      slave: this.slave,
      channelLossDb: this.channelLossDb,
      internalErrors: this.internalErrors,
      externalErrors: this.externalErrors,
      pattern: this.pattern,
    };
  }
}

/** 供面板 / 弹窗复用的模式文案。 */
export function loopbackLabel(mode, lossDb = 0) {
  if (mode === 'internal') return 'Internal（器件内部 TX→RX）';
  if (mode === 'external') return `External（经通道，约 ${lossDb} dB）`;
  return '未进入';
}
