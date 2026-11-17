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

/** 配置读写请求（Type 0 / Type 1）。 */
export function buildCfg(opts = {}) {
  const {
    write = false, type1 = false, bdf = 0x0100, reg = 0,
    requester = 0, tag = 0, data = 0,
  } = opts;
  const fmt = write ? FMT['3DW_DATA'] : FMT['3DW_NODATA'];
  const type = type1 ? TLP_TYPE.CFG1 : TLP_TYPE.CFG0;
  const bytes = [];
  pushDw(bytes, headerDw0(fmt, type, write ? 1 : 0));
  pushDw(bytes, ((bdf & 0xffff) << 16) | (reg & 0xffc));
  const ids = idFields(requester, tag, 0, 0xf);
  pushDw(bytes, ids.dw);
  if (write) pushDw(bytes, data);
  return decode(bytes);
}

/** 内存读写请求。 */
export function buildMem(opts = {}) {
  const {
    write = false, address = 0, is64 = false, lengthDw = 1,
    requester = 0, tag = 0, dataDws = [], at = 0,
  } = opts;
  const fmt = is64
    ? (write ? FMT['4DW_DATA'] : FMT['4DW_NODATA'])
    : (write ? FMT['3DW_DATA'] : FMT['3DW_NODATA']);
  const bytes = [];
  pushDw(bytes, headerDw0(fmt, TLP_TYPE.MEM, lengthDw, { at }));
  if (is64) pushDw(bytes, Math.floor(address / 0x100000000) >>> 0);
  pushDw(bytes, (address & 0xfffffffc) >>> 0);
  const ids = idFields(requester, tag, 0, 0xf);
  pushDw(bytes, ids.dw);
  if (write) {
    for (const dw of dataDws) pushDw(bytes, dw);
  }
  return decode(bytes);
}

/** 完成报文。dataDws 为空时生成 Cpl，否则生成 CplD。 */
export function buildCpl(opts = {}) {
  const {
    requester = 0, completer = 0, tag = 0, status = 0,
    dataDws = [], byteCount = null, lowerAddress = 0,
  } = opts;
  const hasData = Array.isArray(dataDws) && dataDws.length > 0;
  const bytes = [];
  pushDw(bytes, headerDw0(hasData ? FMT['3DW_DATA'] : FMT['3DW_NODATA'], TLP_TYPE.CPL, hasData ? dataDws.length : 0));
  const bc = byteCount ?? (hasData ? dataDws.length * 4 : 0);
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
      desc: '数据载荷长度（DW）；无数据报文为 0' },
  ];
}

/** 解析 TLP。 */
export function decode(bytes) {
  const dw0 = readDw(bytes, 0);
  const fmt = (dw0 >>> 29) & 0x7;
  const type = (dw0 >>> 24) & 0x1f;
  const length = dw0 & 0x3ff;
  const tc = (dw0 >>> 20) & 0x7;
  const td = (dw0 >>> 15) & 1;
  const ep = (dw0 >>> 14) & 1;
  const attr = (dw0 >>> 12) & 0x3;
  const at = (dw0 >>> 10) & 0x3;

  const hasData = fmt === 2 || fmt === 3;
  const is4dw = fmt === 1 || fmt === 3;
  const headerLen = is4dw ? 16 : 12;
  const dataLen = hasData ? length * 4 : 0;
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
    const bdf = (dw1 >>> 16) & 0xffff;
    const reg = dw1 & 0xffc;
    const requester = (dw2 >>> 16) & 0xffff;
    const tag = (dw2 >>> 8) & 0xff;
    const lastBe = (dw2 >>> 4) & 0xf;
    const firstBe = dw2 & 0xf;
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
    Object.assign(extra, { bdf, reg, requester, tag });
  } else if (type === TLP_TYPE.CPL) {
    name = hasData ? 'CplD' : 'Cpl';
    const dw1 = readDw(bytes, 4);
    const dw2 = readDw(bytes, 8);
    const completer = (dw1 >>> 16) & 0xffff;
    const status = (dw1 >>> 13) & 0x7;
    const bcm = (dw1 >>> 12) & 1;
    const byteCount = dw1 & 0xfff;
    const requester = (dw2 >>> 16) & 0xffff;
    const tag = (dw2 >>> 8) & 0xff;
    const lowerAddress = dw2 & 0x7f;
    fields = [
      ...commonFields(fmt, type, length, name),
      { name: 'Completer ID', value: hex32(completer), display: bdfText(completer), desc: '完成者 BDF' },
      { name: 'Status', value: `0b${status.toString(2).padStart(3, '0')}`,
        display: CPL_STATUS[status] || String(status), desc: '完成状态' },
      { name: 'Byte Count', value: String(byteCount), display: `${byteCount} B`, desc: '剩余字节数' },
      { name: 'Requester ID', value: hex32(requester), display: bdfText(requester), desc: '请求者 BDF' },
      { name: 'Tag', value: String(tag), display: `0x${tag.toString(16).toUpperCase().padStart(2, '0')}`,
        desc: '与请求匹配的 Tag' },
      { name: 'Lower Address', value: String(lowerAddress), display: `0x${lowerAddress.toString(16).toUpperCase()}`,
        desc: '数据起始地址低 7 位' },
      { name: 'BCM', value: String(bcm), display: bcm ? '1（多完成）' : '0', desc: 'Byte Count Modified' },
    ];
    summary = `${name}  Status=${CPL_STATUS[status] || status}  ByteCount=${byteCount}B`
      + `  Data=${hasData ? hex32(dataDws[0] || 0) : '-'}  Tag=0x${tag.toString(16).toUpperCase()}`;
    Object.assign(extra, { completer, requester, tag, status, byteCount, dataDws });
  } else if (type === TLP_TYPE.MEM) {
    name = hasData ? 'MWr' : 'MRd';
    let address;
    let dwIndex;
    if (is4dw) {
      address = readDw(bytes, 4) * 0x100000000 + ((readDw(bytes, 8) & 0xfffffffc) >>> 0);
      dwIndex = 12;
    } else {
      address = (readDw(bytes, 4) & 0xfffffffc) >>> 0;
      dwIndex = 8;
    }
    const ids = readDw(bytes, dwIndex);
    const requester = (ids >>> 16) & 0xffff;
    const tag = (ids >>> 8) & 0xff;
    fields = [
      ...commonFields(fmt, type, length, name),
      { name: 'Address', value: hex32(address), display: `0x${address.toString(16).toUpperCase()}`,
        desc: is4dw ? '64bit 地址' : '32bit 地址' },
      { name: 'Requester ID', value: hex32(requester), display: bdfText(requester), desc: '请求者 BDF' },
      { name: 'Tag', value: String(tag), display: `0x${tag.toString(16).toUpperCase().padStart(2, '0')}`,
        desc: '用于匹配 Completion' },
    ];
    summary = `${name}  Addr=0x${address.toString(16).toUpperCase()}  Len=${length}DW  Tag=0x${tag.toString(16).toUpperCase()}`;
    Object.assign(extra, { address, requester, tag });
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
