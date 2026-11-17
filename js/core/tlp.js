/**
 * TLP 构建与解析（Non-Flit 模式，M2 范围）。
 * 覆盖：配置读写、内存读写、完成报文（Cpl / CplD）。
 */

export const FMT = {
  '3DW_NODATA': 0,
  '4DW_NODATA': 1,
  '3DW_DATA': 2,
  '4DW_DATA': 3,
};

export const TLP_TYPE = {
  MEM: 0x00,
  CFG0: 0x04,
  CFG1: 0x05,
  CPL: 0x0a,
  MSG: 0x10,
};

export const CPL_STATUS = {
  0: 'SC（成功）',
  1: 'UR（不支持的请求）',
  2: 'CRS（配置请求重试）',
  4: 'CA（完成中止）',
};

function u32(n) {
  return n >>> 0;
}

function pushDw(arr, v) {
  const x = v >>> 0;
  arr.push(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff);
}

function readDw(bytes, off) {
  return u32((bytes[off] || 0)
    | ((bytes[off + 1] || 0) << 8)
    | ((bytes[off + 2] || 0) << 16)
    | ((bytes[off + 3] || 0) << 24));
}

function headerDw0(fmt, type, length, opts = {}) {
  const { tc = 0, td = 0, ep = 0, attr = 0, at = 0 } = opts;
  return u32((fmt << 29)
    | (type << 24)
    | ((tc & 0x7) << 20)
    | ((td & 1) << 15)
    | ((ep & 1) << 14)
    | ((attr & 0x3) << 12)
    | ((at & 0x3) << 10)
    | (length & 0x3ff));
}

export function hex32(v) {
  return '0x' + u32(v).toString(16).toUpperCase().padStart(8, '0');
}

export function bdfText(bdf) {
  const bus = (bdf >> 8) & 0xff;
  const dev = (bdf >> 3) & 0x1f;
  const fn = bdf & 0x7;
  return `${bus.toString(16).padStart(2, '0')}:${dev.toString(16).padStart(2, '0')}.${fn}`;
}

function idFields(requester, tag, lastBe, firstBe) {
  return {
    requester,
    tag,
    lastBe,
    firstBe,
    dw: u32(((requester & 0xffff) << 16)
      | ((tag & 0xff) << 8)
      | ((lastBe & 0xf) << 4)
      | (firstBe & 0xf)),
  };
}

// Internal bytes are little-endian within each DWORD, in protocol DWORD order.
// This is a logical header view, not a captured on-wire byte stream.
function uint(value, max, name) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError(`${name} 超出支持范围`);
  return value;
}
function idsValid(requester, tag) {
  uint(requester, 0xffff, 'Requester ID'); uint(tag, 0xff, '8-bit Tag');
}
function addressValue(address, is64) {
  if (typeof address !== 'bigint' && !Number.isSafeInteger(address)) throw new RangeError('地址须为安全整数或 BigInt');
  const value = BigInt(address);
  if (value < 0n || value > (is64 ? 0xffffffffffffffffn : 0xffffffffn) || value % 4n) {
    throw new RangeError('地址须 DWORD 对齐且适合所选头格式');
  }
  return value;
}
function byteEnables(length, first, last, address) {
  uint(first, 15, 'First BE'); uint(last, 15, 'Last BE');
  if (length === 1 && last !== 0) throw new RangeError('单 DW 请求 Last BE 必须为 0');
  if (length > 1 && (!first || !last)) throw new RangeError('多 DW 请求首尾 BE 必须非零');
  if (length > 1 && !(length === 2 && address % 8n === 0n)) {
    if (![8, 12, 14, 15].includes(first) || ![1, 3, 7, 15].includes(last)) {
      throw new RangeError('跨 DW 有效字节必须连续（QW 对齐 2DW 例外）');
    }
  }
}

/** 配置读写请求（Type 0 / Type 1）。 */
export function buildCfg(opts = {}) {
  const {
    write = false, type1 = false, bdf = 0x0100, reg = 0,
    requester = 0, tag = 0, data = 0, firstBe = 0xf,
  } = opts;
  idsValid(requester, tag); uint(bdf, 0xffff, 'BDF'); uint(reg, 0xffc, '配置偏移');
  if (reg % 4) throw new RangeError('配置偏移必须 DWORD 对齐');
  uint(firstBe, 15, 'First BE'); uint(data, 0xffffffff, '配置数据');
  const fmt = write ? FMT['3DW_DATA'] : FMT['3DW_NODATA'];
  const type = type1 ? TLP_TYPE.CFG1 : TLP_TYPE.CFG0;
  const bytes = [];
  pushDw(bytes, headerDw0(fmt, type, 1));
  const ids = idFields(requester, tag, 0, firstBe);
  pushDw(bytes, ids.dw);
  pushDw(bytes, ((bdf & 0xffff) << 16) | reg);
  if (write) pushDw(bytes, data);
  return decode(bytes);
}

/** 内存读写请求。 */
export function buildMem(opts = {}) {
  const {
    write = false, address = 0, is64 = false, lengthDw = 1,
    requester = 0, tag = 0, dataDws = [], at = 0,
    firstBe = 0xf, lastBe = lengthDw === 1 ? 0 : 0xf,
  } = opts;
  idsValid(requester, tag); uint(lengthDw, 1024, 'Length');
  if (!lengthDw) throw new RangeError('内存请求 Length 必须为 1–1024 DW');
  uint(at, 2, 'Address Type');
  const addr = addressValue(address, is64);
  if (Number(addr & 0xfffn) + lengthDw * 4 > 4096) throw new RangeError('请求不能跨越 4KB 边界');
  byteEnables(lengthDw, firstBe, lastBe, addr);
  if (!Array.isArray(dataDws) || (write ? dataDws.length !== lengthDw : dataDws.length !== 0)) throw new RangeError('载荷与请求 Length/类型不匹配');
  dataDws.forEach(v => uint(v, 0xffffffff, '数据 DWORD'));
  const fmt = is64
    ? (write ? FMT['4DW_DATA'] : FMT['4DW_NODATA'])
    : (write ? FMT['3DW_DATA'] : FMT['3DW_NODATA']);
  const bytes = [];
  pushDw(bytes, headerDw0(fmt, TLP_TYPE.MEM, lengthDw, { at }));
  const ids = idFields(requester, tag, lastBe, firstBe);
  pushDw(bytes, ids.dw);
  if (is64) pushDw(bytes, Number(addr >> 32n));
  pushDw(bytes, Number(addr & 0xffffffffn));
  if (write) {
    for (const dw of dataDws) pushDw(bytes, dw);
  }
  return decode(bytes);
}

/** 完成报文。dataDws 为空时生成 Cpl，否则生成 CplD。 */
export function buildCpl(opts = {}) {
  const {
    requester = 0, completer = 0, tag = 0, status = 0,
    dataDws = [], byteCount = null, lowerAddress = 0, requestKind = null,
  } = opts;
  idsValid(requester, tag); uint(completer, 0xffff, 'Completer ID'); uint(lowerAddress, 127, 'Lower Address');
  if (![0, 1, 2, 4].includes(status)) throw new RangeError('不支持的 Completion Status');
  if (status === 2 && requestKind && !/^CfgRd|^CfgWr/.test(requestKind)) throw new RangeError('CRS 仅适用于配置请求');
  if (!Array.isArray(dataDws) || dataDws.length > 1024) throw new RangeError('Completion 载荷长度无效');
  dataDws.forEach(v => uint(v, 0xffffffff, '数据 DWORD'));
  const hasData = dataDws.length > 0;
  if (hasData && status !== 0) throw new RangeError('失败 Completion 不能携带数据');
  const bytes = [];
  pushDw(bytes, headerDw0(hasData ? FMT['3DW_DATA'] : FMT['3DW_NODATA'], TLP_TYPE.CPL, hasData ? dataDws.length : 0));
  const bc = byteCount ?? (hasData ? dataDws.length * 4 : 4);
  uint(bc, 4096, 'Byte Count');
  if (bc === 0) throw new RangeError('Byte Count 使用语义值 1–4096；4096 编码为 0');
  if (hasData && bc + (lowerAddress & 3) + 3 < dataDws.length * 4) throw new RangeError('Byte Count 与 Completion 有效数据量不匹配');
  pushDw(bytes, ((completer & 0xffff) << 16)
    | ((status & 0x7) << 13)
    | (bc & 0xfff));
  pushDw(bytes, ((requester & 0xffff) << 16)
    | ((tag & 0xff) << 8)
    | (lowerAddress & 0x7f));
  if (hasData) {
    for (const dw of dataDws) pushDw(bytes, dw);
  }
  return decode(bytes);
}

/** 消息请求（Msg，无数据）。 */
export function buildMsg(opts = {}) {
  const { code = 0x30, requester = 0, tag = 0 } = opts;
  const bytes = [];
  pushDw(bytes, headerDw0(FMT['3DW_NODATA'], TLP_TYPE.MSG, 0));
  pushDw(bytes, code & 0xff);
  pushDw(bytes, ((requester & 0xffff) << 16) | ((tag & 0xff) << 8));
  return decode(bytes);
}

function commonFields(fmt, type, length, name) {
  return [
    { name: 'Fmt', value: `0b${fmt.toString(2).padStart(3, '0')}`,
      display: `${fmt}（${fmt === 0 ? '3DW 无数据' : fmt === 1 ? '4DW 无数据' : fmt === 2 ? '3DW 带数据' : '4DW 带数据'}）`,
      desc: '头长度与是否携带数据' },
    { name: 'Type', value: `0b${type.toString(2).padStart(5, '0')}`,
      display: `${name}`, desc: '事务类型' },
    { name: 'Length', value: String(length), display: `${length} DW`,
      desc: '请求读取或传送的数据量（DW）；MRd/CfgRd 无载荷但 Length 非零' },
  ];
}

/** 解析 TLP。 */
export function decode(bytes) {
  if (!(Array.isArray(bytes) || bytes instanceof Uint8Array) || bytes.length < 12 || Array.from(bytes).some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new RangeError('TLP 字节流无效或头部截断');
  const dw0 = readDw(bytes, 0);
  const fmt = (dw0 >>> 29) & 0x7;
  const type = (dw0 >>> 24) & 0x1f;
  const encodedLength = dw0 & 0x3ff;
  const length = encodedLength || ((type === TLP_TYPE.MEM || (type === TLP_TYPE.CPL && (fmt === 2 || fmt === 3))) ? 1024 : 0);
  const tc = (dw0 >>> 20) & 0x7;
  const td = (dw0 >>> 15) & 1;
  const ep = (dw0 >>> 14) & 1;
  const attr = (dw0 >>> 12) & 0x3;
  const at = (dw0 >>> 10) & 0x3;

  const hasData = fmt === 2 || fmt === 3;
  const is4dw = fmt === 1 || fmt === 3;
  const headerLen = is4dw ? 16 : 12;
  const dataLen = hasData ? length * 4 : 0;
  if (bytes.length !== headerLen + dataLen) throw new RangeError('TLP 字节数与头格式/Length 不匹配（不支持 Digest/Prefix）');
  if (td) throw new RangeError('此字段模型尚不支持 TLP Digest');
  if (type === TLP_TYPE.CFG0 || type === TLP_TYPE.CFG1) {
    if (![0, 2].includes(fmt) || length !== 1) throw new RangeError('配置请求须为 3DW、Length=1');
  } else if (type === TLP_TYPE.MEM && ![0, 1, 2, 3].includes(fmt)) throw new RangeError('内存请求 Fmt 无效');
  else if (type === TLP_TYPE.CPL && (![0, 2].includes(fmt) || (!hasData && encodedLength !== 0))) throw new RangeError('Completion Fmt/Length 无效');
  const dataBytes = bytes.slice(headerLen, headerLen + dataLen);
  const dataDws = [];
  for (let i = 0; i + 4 <= dataBytes.length; i += 4) dataDws.push(readDw(dataBytes, i));

  let name = 'Unknown';
  let fields = [];
  let summary = '';
  const extra = {};

  if (type === TLP_TYPE.CFG0 || type === TLP_TYPE.CFG1) {
    const isWrite = fmt === 2;
    const type1 = type === TLP_TYPE.CFG1;
    name = (type1 ? 'Cfg' : 'Cfg') + (isWrite ? 'Wr' : 'Rd') + (type1 ? '1' : '0');
    const dw1 = readDw(bytes, 4);
    const dw2 = readDw(bytes, 8);
    const bdf = (dw2 >>> 16) & 0xffff;
    const reg = dw2 & 0xffc;
    const requester = (dw1 >>> 16) & 0xffff;
    const tag = (dw1 >>> 8) & 0xff;
    const lastBe = (dw1 >>> 4) & 0xf;
    const firstBe = dw1 & 0xf;
    if (lastBe) throw new RangeError('配置请求 Last BE 必须为 0');
    fields = [
      ...commonFields(fmt, type, length, name),
      { name: 'BDF', value: hex32(bdf), display: bdfText(bdf), desc: '目标 Bus/Device/Function' },
      { name: 'Register', value: hex32(reg), display: `0x${reg.toString(16).toUpperCase().padStart(3, '0')}`,
        desc: '配置空间寄存器偏移（4 字节对齐）' },
      { name: 'Requester ID', value: hex32(requester), display: bdfText(requester), desc: '发起请求的 BDF' },
      { name: 'Tag', value: String(tag), display: `0x${tag.toString(16).toUpperCase().padStart(2, '0')}`,
        desc: '用于匹配 Completion' },
      { name: 'First / Last BE', value: `${firstBe.toString(16)} / ${lastBe.toString(16)}`,
        display: `${firstBe.toString(16)}h / ${lastBe.toString(16)}h`, desc: '首/尾 DW 字节使能' },
      ...(isWrite ? [{ name: 'Data', value: hex32(dataDws[0] || 0), display: hex32(dataDws[0] || 0), desc: '写入的 1 DW 数据' }] : []),
    ];
    summary = `${name}  BDF=${bdfText(bdf)}  Reg=0x${reg.toString(16).toUpperCase().padStart(3, '0')}`
      + (isWrite ? `  Data=${hex32(dataDws[0] || 0)}` : '') + `  Tag=0x${tag.toString(16).toUpperCase()}`;
    Object.assign(extra, { bdf, reg, requester, tag, firstBe, lastBe });
  } else if (type === TLP_TYPE.CPL) {
    name = hasData ? 'CplD' : 'Cpl';
    const dw1 = readDw(bytes, 4);
    const dw2 = readDw(bytes, 8);
    const completer = (dw1 >>> 16) & 0xffff;
    const status = (dw1 >>> 13) & 0x7;
    const bcm = (dw1 >>> 12) & 1;
    const byteCount = (dw1 & 0xfff) || 4096;
    if (![0, 1, 2, 4].includes(status) || (hasData && status !== 0)) throw new RangeError('Completion 状态/载荷无效');
    const requester = (dw2 >>> 16) & 0xffff;
    const tag = (dw2 >>> 8) & 0xff;
    const lowerAddress = dw2 & 0x7f;
    if (hasData && byteCount + (lowerAddress & 3) + 3 < length * 4) throw new RangeError('Completion Byte Count/Length 不匹配');
    fields = [
      ...commonFields(fmt, type, length, name),
      { name: 'Completer ID', value: hex32(completer), display: bdfText(completer), desc: '完成者 BDF' },
      { name: 'Status', value: `0b${status.toString(2).padStart(3, '0')}`,
        display: CPL_STATUS[status] || String(status), desc: '完成状态' },
      { name: 'Byte Count', value: String(byteCount), display: `${byteCount} B`, desc: '包含当前包在内尚需完成的字节数；编码 0 表示 4096B' },
      { name: 'Requester ID', value: hex32(requester), display: bdfText(requester), desc: '请求者 BDF' },
      { name: 'Tag', value: String(tag), display: `0x${tag.toString(16).toUpperCase().padStart(2, '0')}`,
        desc: '与请求匹配的 Tag' },
      { name: 'Lower Address', value: String(lowerAddress), display: `0x${lowerAddress.toString(16).toUpperCase()}`,
        desc: '数据起始地址低 7 位' },
      { name: 'BCM', value: String(bcm), display: bcm ? '1（PCI-X 特例）' : '0', desc: 'Byte Count Modified' },
    ];
    summary = `${name}  Status=${CPL_STATUS[status] || status}  ByteCount=${byteCount}B`
      + `  Data=${hasData ? hex32(dataDws[0] || 0) : '-'}  Tag=0x${tag.toString(16).toUpperCase()}`;
    Object.assign(extra, { completer, requester, tag, status, byteCount, lowerAddress, bcm, dataDws });
  } else if (type === TLP_TYPE.MEM) {
    name = hasData ? 'MWr' : 'MRd';
    const addr = is4dw
      ? (BigInt(readDw(bytes, 8)) << 32n) | BigInt((readDw(bytes, 12) & 0xfffffffc) >>> 0)
      : BigInt((readDw(bytes, 8) & 0xfffffffc) >>> 0);
    const address = addr <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(addr) : addr;
    const ids = readDw(bytes, 4);
    const requester = (ids >>> 16) & 0xffff;
    const tag = (ids >>> 8) & 0xff;
    const firstBe = ids & 15;
    const lastBe = (ids >>> 4) & 15;
    byteEnables(length, firstBe, lastBe, addr);
    if (Number(addr & 0xfffn) + length * 4 > 4096) throw new RangeError('请求跨越 4KB 边界');
    fields = [
      ...commonFields(fmt, type, length, name),
      { name: 'Address', value: `0x${address.toString(16).toUpperCase()}`, display: `0x${address.toString(16).toUpperCase()}`,
        desc: is4dw ? '64bit 地址' : '32bit 地址' },
      { name: 'Requester ID', value: hex32(requester), display: bdfText(requester), desc: '请求者 BDF' },
      { name: 'Tag', value: String(tag), display: `0x${tag.toString(16).toUpperCase().padStart(2, '0')}`,
        desc: '用于匹配 Completion' },
    ];
    summary = `${name}  Addr=0x${address.toString(16).toUpperCase()}  Len=${length}DW  Tag=0x${tag.toString(16).toUpperCase()}`;
    Object.assign(extra, { address, requester, tag, firstBe, lastBe });
  } else if (type === TLP_TYPE.MSG) {
    name = 'Msg';
    const code = readDw(bytes, 4) & 0xff;
    const dw2 = readDw(bytes, 8);
    const requester = (dw2 >>> 16) & 0xffff;
    const tag = (dw2 >>> 8) & 0xff;
    const codeName = {
      0x04: 'Page Request',
      0x05: 'PRG Response',
      0x18: 'PM_PME',
      0x19: 'PME_Turn_Off',
      0x1b: 'PME_TO_Ack',
      0x20: 'Invalidate Request',
      0x21: 'Invalidate Completion',
      0x30: 'ERR_COR',
      0x31: 'ERR_NONFATAL',
      0x33: 'ERR_FATAL',
    }[code];
    fields = [
      ...commonFields(fmt, type, length, name),
      { name: 'Message Code', value: `0x${code.toString(16).toUpperCase()}`,
        display: codeName || `0x${code.toString(16).toUpperCase()}`, desc: '消息类型编码' },
      { name: 'Requester ID', value: hex32(requester), display: bdfText(requester), desc: '发送消息的 BDF' },
      { name: 'Tag', value: String(tag), display: `0x${tag.toString(16).toUpperCase().padStart(2, '0')}`,
        desc: '消息 Tag' },
    ];
    summary = `Msg  Code=0x${code.toString(16).toUpperCase()}${codeName ? `（${codeName}）` : ''}  Requester=${bdfText(requester)}`;
    Object.assign(extra, { messageCode: code, requester, tag });
  } else {
    fields = commonFields(fmt, type, length, 'Unknown');
    summary = `Unknown Type 0x${type.toString(16)}`;
  }

  return {
    kind: 'TLP',
    fidelity: type === TLP_TYPE.MSG ? 'schematic' : 'field-model',
    byteOrder: 'little-endian-per-dword',
    protocolMode: 'nonflit',
    name,
    bytes,
    headerLen,
    dataBytes,
    dataDws,
    fmt,
    type,
    tc,
    td,
    ep,
    attr,
    at,
    length,
    fields,
    summary,
    checks: [],
    ...extra,
  };
}
