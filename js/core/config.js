/**
 * Type 0 端点配置空间模型（4KB）。
 * M2 覆盖：ID 寄存器、Command、BAR 探测/分配、配置读写。
 */

const CLASS_NAMES = {
  0x020000: 'Ethernet controller',
  0x010802: 'NVMe controller',
  0x0c0330: 'USB xHCI controller',
  0x030000: 'VGA controller',
  0x060400: 'PCI-to-PCI bridge',
};

const COMMAND_BITS = [
  { bit: 0, name: 'I/O Space' },
  { bit: 1, name: 'Memory Space' },
  { bit: 2, name: 'Bus Master' },
  { bit: 3, name: 'Special Cycles' },
  { bit: 6, name: 'Parity Error Response' },
  { bit: 8, name: 'SERR Enable' },
  { bit: 10, name: 'Interrupt Disable' },
];

export class ConfigSpace {
  constructor(opts = {}) {
    this.mem = new Uint8Array(4096);
    this.vendorId = opts.vendorId ?? 0x1234;
    this.deviceId = opts.deviceId ?? 0x5678;
    this.classCode = opts.classCode ?? 0x020000;
    this.bars = [
      { index: 0, offset: 0x10, size: 0x1000, is64: true, baseLow: 0, baseHigh: 0, sizing: false },
      { index: 2, offset: 0x18, size: 0x4000, is64: false, baseLow: 0, baseHigh: 0, sizing: false },
      { index: 3, offset: 0x1c, size: 0x10000, is64: false, baseLow: 0, baseHigh: 0, sizing: false },
    ];
    this.init();
  }

  init() {
    this.write16Raw(0x00, this.vendorId);
    this.write16Raw(0x02, this.deviceId);
    this.write16Raw(0x04, 0x0000);
    this.write16Raw(0x06, 0x0000);
    this.mem[0x08] = 0x01;
    this.write24Raw(0x09, this.classCode);
    this.mem[0x0c] = 0x00;
    this.mem[0x0d] = 0x00;
    this.mem[0x0e] = 0x00;
    this.mem[0x0f] = 0x00;
    this.write16Raw(0x2c, this.vendorId);
    this.write16Raw(0x2e, this.deviceId);
    this.mem[0x34] = 0x00;
    for (const bar of this.bars) this.write32Raw(bar.offset, bar.is64 ? 4 : 0);
  }

  // ---------- 原始读写 ----------
  write16Raw(offset, value) {
    this.mem[offset] = value & 0xff;
    this.mem[offset + 1] = (value >>> 8) & 0xff;
  }

  write24Raw(offset, value) {
    this.mem[offset] = value & 0xff;
    this.mem[offset + 1] = (value >>> 8) & 0xff;
    this.mem[offset + 2] = (value >>> 16) & 0xff;
  }

  write32Raw(offset, value) {
    const v = value >>> 0;
    this.mem[offset] = v & 0xff;
    this.mem[offset + 1] = (v >>> 8) & 0xff;
    this.mem[offset + 2] = (v >>> 16) & 0xff;
    this.mem[offset + 3] = (v >>> 24) & 0xff;
  }

  readRaw(offset, size = 4) {
    let v = 0;
    for (let i = 0; i < size; i += 1) v |= (this.mem[offset + i] || 0) << (8 * i);
    return v >>> 0;
  }

  // ---------- BAR 辅助 ----------
  barAt(offset) {
    for (const bar of this.bars) {
      if (offset === bar.offset) return { bar, half: 'low' };
      if (bar.is64 && offset === bar.offset + 4) return { bar, half: 'high' };
    }
    return null;
  }

  barMask(bar, half) {
    if (bar.is64 && half === 'high') return 0xffffffff;
    return ((~(bar.size - 1) & 0xfffffff0) | (bar.is64 ? 4 : 0)) >>> 0;
  }

  baseHex(bar) {
    if (!bar.is64) return '0x' + (bar.baseLow >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const v = (BigInt(bar.baseHigh >>> 0) << 32n) | BigInt(bar.baseLow >>> 0);
    return '0x' + v.toString(16).toUpperCase().padStart(16, '0');
  }

  // ---------- 配置空间访问 ----------
  validateAccess(offset, size) {
    if (![1, 2, 4].includes(size) || !Number.isInteger(offset)
        || offset < 0 || offset + size > this.mem.length || offset % size) {
      throw new RangeError('配置访问须为自然对齐的 8/16/32 位，范围 0–4095');
    }
  }

  read(offset, size = 4) {
    this.validateAccess(offset, size);
    const aligned = offset & ~3;
    const b = this.barAt(aligned);
    const probing = b && b.bar[b.half === 'low' ? 'probeLow' : 'probeHigh'];
    if (probing) {
      const mask = size === 4 ? 0xffffffff : (2 ** (size * 8) - 1);
      return ((this.barMask(b.bar, b.half) >>> ((offset - aligned) * 8)) & mask) >>> 0;
    }
    return this.readRaw(offset, size);
  }

  write(offset, value, size = 4, byteEnable = (1 << size) - 1) {
    this.validateAccess(offset, size);
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** (size * 8)) throw new RangeError('配置写数据超出访问宽度');
    if (!Number.isInteger(byteEnable) || byteEnable < 0 || byteEnable >= 2 ** size) throw new RangeError('无效配置字节使能');
    const aligned = offset & ~3;
    const b = this.barAt(aligned);
    if (b) {
      if (byteEnable === 0) return;
      const key = b.half === 'low' ? 'probeLow' : 'probeHigh';
      if (size === 4 && value === 0xffffffff && byteEnable === 15) {
        b.bar[key] = true;
        b.bar.sizing = true;
        return;
      }
      let merged = this.readRaw(aligned);
      for (let i = 0; i < size; i++) {
        if (!(byteEnable & (1 << i))) continue;
        const shift = (offset - aligned + i) * 8;
        merged = ((merged & ~(0xff << shift)) | (((value >>> (i * 8)) & 0xff) << shift)) >>> 0;
      }
      b.bar[key] = false;
      b.bar.sizing = !!(b.bar.probeLow || b.bar.probeHigh);
      if (b.half === 'low') {
        b.bar.baseLow = (merged & (~(b.bar.size - 1)) & 0xfffffff0) >>> 0;
        this.write32Raw(aligned, b.bar.baseLow | (b.bar.is64 ? 4 : 0));
      } else {
        b.bar.baseHigh = merged;
        this.write32Raw(aligned, merged);
      }
      return;
    }
    // Implemented Type 0 subset: ID/class/header/subsystem and unimplemented
    // capabilities are read-only. Command exposes only implemented controls.
    for (let i = 0; i < size; i++) {
      if (!(byteEnable & (1 << i))) continue;
      const at = offset + i;
      const incoming = (value >>> (8 * i)) & 0xff;
      const rw = ({ 4: 0x47, 5: 0x05, 0x0c: 0xff, 0x3c: 0xff })[at] || 0;
      const w1c = at === 6 ? 0 : at === 7 ? 0xf9 : 0;
      this.mem[at] = ((this.mem[at] & ~rw) | (incoming & rw)) & ~(incoming & w1c);
    }
  }

  get command() {
    return this.readRaw(0x04, 2);
  }

  get memoryEnabled() {
    return (this.command & 0x2) !== 0;
  }

  get busMasterEnabled() {
    return (this.command & 0x4) !== 0;
  }

  get classCodeText() {
    return CLASS_NAMES[this.classCode] || `0x${this.classCode.toString(16).toUpperCase()}`;
  }

  get commandBits() {
    return COMMAND_BITS.map((b) => ({ ...b, on: ((this.command >> b.bit) & 1) === 1 }));
  }

  hexDump(limit = 256) {
    const rows = [];
    for (let off = 0; off < limit; off += 16) {
      const bytes = Array.from(this.mem.slice(off, off + 16));
      const ascii = bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      rows.push({ offset: off, bytes, ascii });
    }
    return rows;
  }

  snapshot() {
    return {
      vendorId: this.vendorId,
      deviceId: this.deviceId,
      classCode: this.classCode,
      classText: this.classCodeText,
      headerType: this.mem[0x0e],
      command: this.command,
      memoryEnabled: this.memoryEnabled,
      busMasterEnabled: this.busMasterEnabled,
      bars: this.bars.map((b) => ({
        index: b.index,
        offset: b.offset,
        is64: b.is64,
        size: b.size,
        base: this.baseHex(b),
        sizing: b.sizing,
      })),
    };
  }
}

export { CLASS_NAMES, COMMAND_BITS };
