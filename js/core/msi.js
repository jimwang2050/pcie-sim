/**
 * MSI / MSI-X 中断模型（简化）。
 */
export class MsiModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.msiEnabled = false;
    this.msixEnabled = false;
    this.msiAddress = 0xfee00000;
    this.msiData = 0x00000000;
    this.vectorCount = 4;
    this.masked = false;
    this.msixTable = Array.from({ length: 4 }, (_, i) => ({
      index: i,
      address: 0xfee01000 + i * 0x10,
      data: 0x40 + i,
      masked: false,
    }));
    this.lastVector = null;
    this.interrupts = [];
    this.suppressed = 0;
  }

  enableMsi(vectors = 4) {
    this.msiEnabled = true;
    this.vectorCount = vectors;
  }

  enableMsix() {
    this.msixEnabled = true;
  }

  maskMsix(index, masked) {
    const e = this.msixTable[index];
    if (e) e.masked = masked;
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
    if (!this.msixEnabled || !e || e.masked) {
      this.suppressed += 1;
      return false;
    }
    this.interrupts.push({ kind: 'MSI-X', vector: index });
    this.lastVector = index;
    return true;
  }

  snapshot() {
    return {
      msiEnabled: this.msiEnabled,
      msixEnabled: this.msixEnabled,
      msiAddress: this.msiAddress,
      msiData: this.msiData,
      vectorCount: this.vectorCount,
      msixTable: this.msixTable.map((e) => ({ ...e })),
      lastVector: this.lastVector,
      interrupts: this.interrupts.slice(),
      suppressed: this.suppressed,
    };
  }
}
