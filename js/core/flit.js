/**
 * Gen6 / Flit Mode 数据单元模型。
 *
 * 256B Flit 教学布局：
 *   [0, 236)   TLP 区域（可打包多个 TLP，无 STP/END 成帧）
 *   [236, 242) DLP（序号 / TLP 数 / Flit Usage / 状态）
 *   [242, 250) CRC（双份 CRC-32）
 *   [250, 256) FEC（3 组 × 2B）
 *
 * 错误模型：FEC 可纠正 ≤2 bit；超过则 CRC 失败，触发 Flit 级重传。
 */
import { RATE_BY_GEN, byteTimeNs } from './packet.js';
import { buildMem } from './tlp.js';

export const FLIT_SIZE = 256;
export const TLP_AREA = 236;
export const DLP_OFFSET = 236;
export const CRC_OFFSET = 242;
export const FEC_OFFSET = 250;
export const FEC_GROUPS = 3;

export const FLIT_SEGMENTS = [
  { name: 'TLP 区域', offset: 0, length: 236, desc: '承载 TLP；Flit 内无 STP/END 成帧，按 Flit 边界与 TLP 长度解析' },
  { name: 'DLP', offset: 236, length: 6, desc: 'Flit 序号、TLP 数、Flit Usage、Ack/Nak/Discard 状态' },
  { name: 'CRC', offset: 242, length: 8, desc: '双份 CRC-32（FEC 解码后校验）' },
  { name: 'FEC', offset: 250, length: 6, desc: '3 组 FEC 校验字节，用于前向纠错' },
];

const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function fecParity(bytes, group, half) {
  let parity = 0;
  for (let i = group; i < CRC_OFFSET; i += FEC_GROUPS) {
    const v = half === 0 ? bytes[i] : ((bytes[i] << 1) | (bytes[i] >>> 7)) & 0xff;
    parity ^= v;
  }
  return parity & 0xff;
}

export function flitTimeNs(gen, width) {
  return byteTimeNs(gen, width, FLIT_SIZE);
}

function demoMwr() {
  return buildMem({
    write: true, address: 0x80001000, is64: true, lengthDw: 1,
    requester: 0x0000, tag: 0, dataDws: [0xa5a5a5a5],
  });
}

export function buildFlit(opts = {}) {
  const { seq = 0, gen = 6, width = 8, tlps = null, payload = 'idle' } = opts;
  const bytes = new Array(FLIT_SIZE).fill(0);

  let list = tlps;
  if (!list && payload === 'mw') list = [demoMwr()];
  if (!list) list = [];

  let cursor = 0;
  const packed = [];
  let overflow = false;
  for (const tlp of list) {
    const tb = tlp.bytes || [];
    if (cursor + tb.length > TLP_AREA) {
      overflow = true;
      break;
    }
    for (let i = 0; i < tb.length; i += 1) bytes[cursor + i] = tb[i];
    packed.push({
      name: tlp.name,
      offset: cursor,
      length: tb.length,
      summary: tlp.summary,
    });
    cursor += tb.length;
  }
  const payloadBytes = cursor;
  const padding = TLP_AREA - payloadBytes;

  // DLP
  bytes[DLP_OFFSET] = seq & 0xff;
  bytes[DLP_OFFSET + 1] = (seq >> 8) & 0x0f;
  bytes[DLP_OFFSET + 2] = packed.length & 0xff;
  bytes[DLP_OFFSET + 3] = packed.length ? 0x01 : 0x00; // usage: data / idle
  bytes[DLP_OFFSET + 4] = 0x00; // status
  bytes[DLP_OFFSET + 5] = 0x00;

  // CRC：双份
  const crcValue = crc32(bytes, 0, CRC_OFFSET);
  const inv = (~crcValue) >>> 0;
  for (let i = 0; i < 4; i += 1) {
    bytes[CRC_OFFSET + i] = (crcValue >> (8 * i)) & 0xff;
    bytes[CRC_OFFSET + 4 + i] = (inv >> (8 * i)) & 0xff;
  }

  // FEC：3 组，每组 2B
  for (let g = 0; g < FEC_GROUPS; g += 1) {
    bytes[FEC_OFFSET + g * 2] = fecParity(bytes, g, 0);
    bytes[FEC_OFFSET + g * 2 + 1] = fecParity(bytes, g, 1);
  }

  const payloadName = packed.length
    ? `${packed.length} TLP · ${payloadBytes}B`
    : 'IDLE';
  const segments = FLIT_SEGMENTS.map((s) => ({ ...s }));

  return {
    kind: 'FLIT',
    name: 'FLIT',
    seq,
    gen,
    width,
    bytes,
    segments,
    payloadName,
    packed,
    payloadBytes,
    padding,
    overflow,
    dlp: { seq, tlpCount: packed.length, usage: packed.length ? 'DATA' : 'IDLE' },
    crc: { value: crcValue, status: 'OK' },
    fec: { groups: FEC_GROUPS, status: 'OK' },
    retry: { count: 0 },
    check: { status: 'OK', fec: 'OK', crc: 'OK', bitErrors: 0, retry: false },
    summary: `FLIT #${seq} · 256B · ${RATE_BY_GEN[gen] ?? gen} · ${payloadName}`,
    fields: [
      { name: 'Flit 序号', value: String(seq), display: `#${seq}`, desc: '用于 Flit 级 Ack/Nak 与重放' },
      { name: 'Flit 大小', value: '256', display: '256 B', desc: 'Flit Mode 固定 256 字节' },
      { name: 'TLP 区域', value: String(TLP_AREA), display: `${TLP_AREA} B`, desc: '可打包多个 TLP' },
      { name: '已用 / 填充', value: String(payloadBytes), display: `${payloadBytes} B / ${padding} B`, desc: 'TLP 数据与填充字节' },
      { name: 'TLP 数量', value: String(packed.length), display: String(packed.length), desc: '本 Flit 内打包的 TLP 数' },
      { name: 'DLP', value: '6', display: '6 B', desc: '序号 / TLP 数 / Usage / 状态' },
      { name: 'CRC', value: '8', display: '8 B', desc: '双份 CRC-32' },
      { name: 'FEC', value: '6', display: '3 组 × 2B', desc: '前向纠错字节' },
    ],
    realTimeNs: flitTimeNs(gen, width),
  };
}

/** 模拟 FEC / CRC 检查。bitErrors=0 正常；≤2 可纠正；>2 不可纠正。 */
export function checkFlit(flit, { bitErrors = 0 } = {}) {
  const fec = bitErrors === 0 ? 'OK' : (bitErrors <= 2 ? 'CORRECTED' : 'FAIL');
  const crc = bitErrors > 2 ? 'FAIL' : 'OK';
  const status = bitErrors === 0 ? 'OK' : (bitErrors <= 2 ? 'CORRECTED' : 'UNCORRECTABLE');
  const result = { bitErrors, fec, crc, status, retry: status === 'UNCORRECTABLE' };
  flit.check = result;
  flit.fec.status = fec;
  flit.crc.status = crc;
  return result;
}

/** Flit 级统计（FEC 纠正 / 不可纠 / 重传）。 */
export class FlitStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.lastSeq = null;
    this.corrected = 0;
    this.uncorrectable = 0;
    this.retries = 0;
    this.crcFails = 0;
    this.status = '-';
  }

  enable() {
    this.enabled = true;
  }

  onFlit(flit, check) {
    this.lastSeq = flit.seq;
    this.status = check.status;
    if (check.status === 'CORRECTED') this.corrected += 1;
    if (check.status === 'UNCORRECTABLE') this.uncorrectable += 1;
    if (check.crc === 'FAIL') this.crcFails += 1;
  }

  onRetry() {
    this.retries += 1;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      lastSeq: this.lastSeq,
      corrected: this.corrected,
      uncorrectable: this.uncorrectable,
      retries: this.retries,
      crcFails: this.crcFails,
      status: this.status,
    };
  }
}
