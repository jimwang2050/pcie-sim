/**
 * MSI / MSI-X 中断模型（教学子集）。
 *
 * - MSI：使能 + 全局 Mask；被屏蔽的请求不会挂起（MSI 没有 Pending 位）。
 * - MSI-X：Function Mask + Per-vector Mask + Per-vector Pending。
 *   Mask 期间触发只置 Pending，解除屏蔽后补发，不会被丢弃。
 */
export class MsiModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.msiEnabled = false;
    this.msixEnabled = false;
    this.msixFunctionMask = false;
    this.msiAddress = 0xfee00000;
    this.msiData = 0x00000000;
    this.vectorCount = 4;
    this.masked = false;
    this.msixTable = Array.from({ length: 4 }, (_, i) => ({
      index: i,
      address: 0xfee01000 + i * 0x10,
      data: 0x40 + i,
      masked: false,
      pending: false,
    }));
    this.lastVector = null;
    this.interrupts = [];
    this.suppressed = 0;
    this.pendingDelivered = 0;
  }

  enableMsi(vectors = 4) {
    this.msiEnabled = true;
    this.vectorCount = vectors;
  }

  enableMsix() {
    this.msixEnabled = true;
  }

  /** 设置 MSI-X 表项 Mask；解除时补发该表项的 Pending。 */
  maskMsix(index, masked) {
    const e = this.msixTable[index];
    if (!e) return 0;
    e.masked = masked;
    return masked ? 0 : (this.deliverPending(index) ? 1 : 0);
  }

  /** MSI-X Function Mask；解除时补发所有 Pending。 */
  setFunctionMask(masked) {
    this.msixFunctionMask = !!masked;
    return masked ? 0 : this.deliverAllPending();
  }

  /** MSI 全局 Mask（MSI 无 Pending，被屏蔽即丢弃）。 */
  setMsiMask(masked) {
    this.masked = !!masked;
  }

  trigger(vector) {
    if (!this.msiEnabled || this.masked) {
      this.suppressed += 1;
      return false;
    }
    this.interrupts.push({ kind: 'MSI', vector });
    this.lastVector = vector;
    return true;
  }

  triggerMsix(index) {
    const e = this.msixTable[index];
    if (!this.msixEnabled || !e) {
      this.suppressed += 1;
      return false;
    }
    if (this.msixFunctionMask || e.masked) {
      e.pending = true;
      this.suppressed += 1;
      return false;
    }
    this.deliver(index);
    return true;
  }

  deliver(index) {
    const e = this.msixTable[index];
    if (!e) return false;
    e.pending = false;
    this.interrupts.push({ kind: 'MSI-X', vector: index });
    this.lastVector = index;
    return true;
  }

  /** 单个表项解除屏蔽后的补发。 */
  deliverPending(index) {
    const e = this.msixTable[index];
    if (!this.msixEnabled || this.msixFunctionMask || !e || e.masked || !e.pending) return false;
    e.pending = false;
    this.interrupts.push({ kind: 'MSI-X', vector: index, pending: true });
    this.lastVector = index;
    this.pendingDelivered += 1;
    return true;
  }

  deliverAllPending() {
    let n = 0;
    for (const e of this.msixTable) if (this.deliverPending(e.index)) n += 1;
    return n;
  }

  snapshot() {
    return {
      msiEnabled: this.msiEnabled,
      msixEnabled: this.msixEnabled,
      msixFunctionMask: this.msixFunctionMask,
      msiAddress: this.msiAddress,
      msiData: this.msiData,
      vectorCount: this.vectorCount,
      masked: this.masked,
      msixTable: this.msixTable.map((e) => ({ ...e })),
      pending: this.msixTable.filter((e) => e.pending).length,
      lastVector: this.lastVector,
      interrupts: this.interrupts.slice(),
      suppressed: this.suppressed,
      pendingDelivered: this.pendingDelivered,
    };
  }
}
