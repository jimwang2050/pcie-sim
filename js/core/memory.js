/**
 * 简化内存模型：64KB，按 32bit little-endian 访问。
 * 地址通过掩码映射到内存窗口（仿真地址 0x8000_1000 → offset 0x1000）。
 */
export class Memory {
  constructor(size = 0x10000) {
    this.size = size;
    this.bytes = new Uint8Array(size);
    this.reset();
  }

  reset() {
    this.bytes.fill(0);
    for (let i = 0; i < 32; i += 1) {
      this.write32(0x1000 + i * 4, (0xa0000000 + i) >>> 0);
    }
  }

  wrap(addr) {
    return addr & (this.size - 1);
  }

  read32(addr) {
    const o = this.wrap(addr);
    return ((this.bytes[o]
      | (this.bytes[o + 1] << 8)
      | (this.bytes[o + 2] << 16)
      | (this.bytes[o + 3] << 24)) >>> 0);
  }

  write32(addr, value) {
    const o = this.wrap(addr);
    const v = value >>> 0;
    this.bytes[o] = v & 0xff;
    this.bytes[o + 1] = (v >>> 8) & 0xff;
    this.bytes[o + 2] = (v >>> 16) & 0xff;
    this.bytes[o + 3] = (v >>> 24) & 0xff;
  }

  readDws(addr, count) {
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(this.read32(addr + i * 4));
    return out;
  }

  writeDws(addr, dws) {
    dws.forEach((dw, i) => this.write32(addr + i * 4, dw));
  }
}
