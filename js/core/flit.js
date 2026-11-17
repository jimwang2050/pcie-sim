/**
 * Gen6 / Flit Mode 数据单元模型。
 *
 * 256B Flit 教学布局：
 *   [0, 236)   TLP 区域（可打包多个 TLP，无 STP/END 成帧）
 *   [236, 242) DLP（仅作展示占位，不是标准位域编码）
 *   [242, 250) CRC（8B 占位，未实现标准算法）
 *   [250, 256) FEC（3 组 × 2B）
 *
 * 故障结果由场景显式预设；不按 bit 数推导标准 FEC 能力，不执行真实 CRC/FEC。
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
  { name: 'DLP', offset: 236, length: 6, desc: '标准 DLP 为 6B；本模型的序号/数量字节仅为示意，不是标准位域' },
  { name: 'CRC', offset: 242, length: 8, desc: '标准为 8B CRC；本模型未实现，字节置零占位' },
  { name: 'FEC', offset: 250, length: 6, desc: '标准为三路交织 ECC；本模型未实现，字节置零占位' },
];

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

  // CRC/ECC bytes remain zero: no fabricated protection code is presented as PCIe.
  // Actual CRC/FEC and FM TLP/DLP encoding are deferred to the optional M5.

  const payloadName = packed.length
    ? `${packed.length} TLP · ${payloadBytes}B`
    : 'IDLE';
  const segments = FLIT_SEGMENTS.map((s) => ({ ...s }));

  return {
    kind: 'FLIT',
    fidelity: 'schematic',
    wireCompatible: false,
    payloadEncoding: 'nonflit-header-illustration',
    modelNote: '布局示意：TLP 使用 NFM 头作占位；DLP 非标准编码；CRC/FEC 未实现。故障结果为预设。',
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
    crc: { value: null, implemented: false, status: 'NOT_IMPLEMENTED' },
    fec: { groups: FEC_GROUPS, implemented: false, status: 'NOT_IMPLEMENTED' },
    retry: { count: 0 },
    check: { status: 'OK', fec: 'OK', crc: 'OK', bitErrors: 0, retry: false, simulated: true, verified: false },
    summary: `FLIT #${seq} · 256B · ${RATE_BY_GEN[gen] ?? gen} · ${payloadName}`,
    fields: [
      { name: 'Flit 序号', value: String(seq), display: `#${seq}`, desc: '用于 Flit 级 Ack/Nak 与重放' },
      { name: 'Flit 大小', value: '256', display: '256 B', desc: 'Flit Mode 固定 256 字节' },
      { name: 'TLP 区域', value: String(TLP_AREA), display: `${TLP_AREA} B`, desc: '可打包多个 TLP' },
      { name: '已用 / 填充', value: String(payloadBytes), display: `${payloadBytes} B / ${padding} B`, desc: 'TLP 数据与填充字节' },
      { name: 'TLP 数量', value: String(packed.length), display: String(packed.length), desc: '本 Flit 内打包的 TLP 数' },
      { name: 'DLP', value: '6', display: '6 B', desc: '示意占位字段，非标准 DLP 位域' },
      { name: 'CRC', value: '8', display: '8 B', desc: '8B CRC 占位；未执行真实校验' },
      { name: 'FEC', value: '6', display: '3 组 × 2B', desc: '前向纠错字节' },
    ],
    realTimeNs: flitTimeNs(gen, width),
  };
}

/** Record an explicitly scripted outcome, never a byte-level CRC/FEC verdict. */
export function checkFlit(flit, { bitErrors = 0, outcome = null } = {}) {
  if (!Number.isInteger(bitErrors) || bitErrors < 0) throw new RangeError('示意误码数必须为非负整数');
  if (bitErrors > 0 && outcome === null) throw new RangeError('示意故障必须显式指定 outcome；不能按误码 bit 数推导纠错结果');
  const selected = outcome ?? 'clean';
  if (!['clean', 'corrected', 'uncorrectable'].includes(selected)) throw new RangeError('未知故障示意结果');
  const fec = selected === 'corrected' ? 'CORRECTED' : selected === 'uncorrectable' ? 'FAIL' : 'OK';
  const crc = selected === 'uncorrectable' ? 'FAIL' : 'OK';
  const status = selected === 'clean' ? 'OK' : selected === 'corrected' ? 'CORRECTED' : 'UNCORRECTABLE';
  const result = { bitErrors, fec, crc, status, retry: selected === 'uncorrectable', simulated: true, verified: false };
  flit.check = result;
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
