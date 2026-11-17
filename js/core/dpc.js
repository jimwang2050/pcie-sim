/**
 * DPC（Downstream Port Containment）与 RP PIO 简化模型。
 *
 * DPC：下游端口检测到不可纠正错误后自动隔离链路，阻止错误 TLP 继续下泄，
 *      并通过中断通知软件；软件清除 Trigger 后复位链路恢复。
 * RP PIO：DPC 触发后，Root Port 对未能转发的下游请求直接生成 UR Completion，
 *         避免请求方永久等待（Completion Timeout）。
 */
export class DpcModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.state = 'disabled';      // disabled | normal | triggered | contained | recovering
    this.reason = '';             // 触发原因（ERR_FATAL / Poisoned TLP / Completion Timeout）
    this.egressControl = false;   // 阻止下游 TLP 继续发送
    this.rpPio = false;           // Root Port PIO 生成 UR Completion
    this.triggered = false;
    this.interrupts = 0;
    this.urCompletions = 0;
    this.blocked = 0;
  }

  enable({ egressControl = true, rpPio = true } = {}) {
    this.enabled = true;
    this.state = 'normal';
    this.egressControl = egressControl;
    this.rpPio = rpPio;
  }

  /** DPC 触发：置 Triggered、记录原因并产生中断。 */
  trigger(reason) {
    if (!this.enabled || this.triggered) return false;
    this.triggered = true;
    this.state = 'triggered';
    this.reason = reason;
    this.interrupts += 1;
    return true;
  }

  /** 链路隔离（DL_Down / Disabled）完成。 */
  contain() {
    if (!this.triggered) return false;
    this.state = 'contained';
    return true;
  }

  /** Egress Control 丢弃一条下游 TLP。 */
  block() {
    this.blocked += 1;
    return this.egressControl;
  }

  /** RP PIO 生成一条 UR Completion。 */
  urCompletion() {
    if (!this.rpPio) return false;
    this.urCompletions += 1;
    return true;
  }

  /** 软件写 DPC Control.Trigger = 0，清除触发状态。 */
  clear() {
    this.triggered = false;
    this.reason = '';
    this.state = this.enabled ? 'normal' : 'disabled';
  }

  snapshot() {
    return {
      enabled: this.enabled,
      state: this.state,
      reason: this.reason,
      egressControl: this.egressControl,
      rpPio: this.rpPio,
      triggered: this.triggered,
      interrupts: this.interrupts,
      urCompletions: this.urCompletions,
      blocked: this.blocked,
    };
  }
}
