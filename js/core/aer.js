/**
 * AER（Advanced Error Reporting）教学子集。
 *
 * 区分三件事：
 *  - 错误被“检出并记录”（Status 位/计数），即使消息被屏蔽也会发生；
 *  - 错误消息（ERR_COR / ERR_NONFATAL / ERR_FATAL）是否真的发出，由 Mask 与严重级别决定；
 *  - 主机侧中断由 RC 产生，不属于 EP 的错误消息本身。
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
    this.mask = { cor: false, nonfatal: false, fatal: false };
    this.severity = { cor: 'cor', nonfatal: 'nonfatal', fatal: 'fatal' };
    this.messages = 0;
    this.masked = 0;
  }

  enable() {
    this.enabled = true;
  }

  /** Uncorrectable Error Mask：只抑制消息，不抑制错误记录。 */
  setMask(severity, masked) {
    if (severity in this.mask) this.mask[severity] = !!masked;
  }

  /** Uncorrectable Error Severity：决定该错误按哪个级别上报。 */
  setSeverity(severity, effective) {
    if (severity in this.severity) this.severity[severity] = effective;
  }

  /**
   * 记录一次错误。返回 { ok, reason, severity }：
   * ok=false 表示消息被 Mask 抑制，但错误已计数。
   * 计数按“上报级别”（Severity 重映射后）归类，与 AER 消息类别一致。
   */
  report(severity, message) {
    const effective = this.severity[severity] || severity;
    if (effective === 'cor') this.correctable += 1;
    else if (effective === 'nonfatal') this.nonfatal += 1;
    else this.fatal += 1;

    if (!this.enabled) {
      this.log.push({ severity, message, effective, reported: false, reason: 'disabled' });
      return { ok: false, reason: 'disabled', severity: effective };
    }
    if (this.mask[effective]) {
      this.masked += 1;
      this.log.push({ severity, message, effective, reported: false, reason: 'masked' });
      return { ok: false, reason: 'masked', severity: effective };
    }
    this.messages += 1;
    this.log.push({ severity, message, effective, reported: true });
    return { ok: true, severity: effective };
  }

  snapshot() {
    return {
      enabled: this.enabled,
      correctable: this.correctable,
      nonfatal: this.nonfatal,
      fatal: this.fatal,
      log: this.log.slice(),
      mask: { ...this.mask },
      severity: { ...this.severity },
      messages: this.messages,
      masked: this.masked,
    };
  }
}
