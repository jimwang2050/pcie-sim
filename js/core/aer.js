/**
 * AER（Advanced Error Reporting）简化模型。
 * 记录 correctable / non-fatal / fatal 错误与消息日志。
 */
export class AerModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.correctable = 0;
    this.nonfatal = 0;
    this.fatal = 0;
    this.log = [];
  }

  enable() {
    this.enabled = true;
  }

  report(severity, message) {
    if (severity === 'cor') this.correctable += 1;
    else if (severity === 'nonfatal') this.nonfatal += 1;
    else this.fatal += 1;
    this.log.push({ severity, message });
  }

  snapshot() {
    return {
      enabled: this.enabled,
      correctable: this.correctable,
      nonfatal: this.nonfatal,
      fatal: this.fatal,
      log: this.log.slice(),
    };
  }
}
