/**
 * 场景：内存写（MWr，Posted）+ 写后读回。
 * 展示 P 信用消耗 / UpdateFC 归还，以及 Posted 事务无 Completion。
 */
import { buildMem, buildCpl, hex32 } from '../core/tlp.js';
import { buildFcDllp } from '../core/fc.js';
import {
  setupMemScenario, fcInit, tlpPair, ackPair, dllpPair,
  MEM_ADDR, RC_ID, EP_ID, US,
} from './mem_common.js';

const WRITE_DWS = [
  0xdeadbeef, 0xcafebabe, 0x12345678, 0x9abcdef0,
  0x0badf00d, 0xfeedface, 0xa5a5a5a5, 0x5a5a5a5a,
];

export function buildMemWrite(sim, opts = {}) {
  const gen = opts.gen ?? 3;
  const width = opts.width ?? 8;
  setupMemScenario(sim, gen, width);

  sim.at(0, () => sim.beginPhase('fc-init', '流控初始化', 'pm',
    'InitFC1 / InitFC2 交换 P / NP / Cpl 初始信用'));
  const tAfter = fcInit(sim, 16 * US);

  const t0 = tAfter + 12 * US;
  sim.at(tAfter, () => sim.beginPhase('mem-write', '内存写 MWr（Posted）', 'enum',
    'MWr 为 Posted：无 Completion，仅消耗 P_Hdr/P_Data 信用'));

  const tag = 1;
  const mwr = buildMem({
    write: true, address: MEM_ADDR, is64: true, lengthDw: WRITE_DWS.length,
    requester: RC_ID, tag, dataDws: WRITE_DWS,
  });

  tlpPair(sim, t0, 'RC', 'EP', mwr,
    `MWr  Addr=${hex32(MEM_ADDR)}  Len=8DW  Tag=${tag}  Data[0]=${hex32(WRITE_DWS[0])}`,
    'Posted：无 Completion；消耗 P_Hdr 1 + P_Data 2（32B / 16B）',
    () => {
      sim.fc.consume('RC', 'P_Hdr', 1);
      sim.fc.consume('RC', 'P_Data', 2);
    });
  ackPair(sim, t0 + 4 * US, 'EP', 'RC', `MWr Tag=${tag}`);
  sim.at(t0 + 3 * US, () => sim.mem.writeDws(MEM_ADDR, WRITE_DWS));
  dllpPair(sim, t0 + 10 * US, 'EP', 'RC',
    buildFcDllp('UpdateFC', [{ cls: 'P', hdr: 1, data: 2 }]),
    'UpdateFC（归还 P 信用）',
    'EP 将 32B 写入内存后释放缓冲区，归还 P_Hdr 1 / P_Data 2',
    () => {
      sim.fc.give('RC', 'P_Hdr', 1);
      sim.fc.give('RC', 'P_Data', 2);
    });

  // ---------- 写后读回 ----------
  const t1 = t0 + 34 * US;
  sim.at(t1 - 4 * US, () => sim.beginPhase('mem-readback', '写后读回校验', 'enum',
    'MRd 读回同一地址，CplD 数据应与写入一致'));

  const rtag = 2;
  const rd = buildMem({
    write: false, address: MEM_ADDR, is64: true, lengthDw: 8, requester: RC_ID, tag: rtag,
  });
  const cpl = buildCpl({
    requester: RC_ID, completer: EP_ID, tag: rtag,
    dataDws: WRITE_DWS.slice(), byteCount: 0, lowerAddress: 0,
  });

  tlpPair(sim, t1, 'RC', 'EP', rd,
    `MRd  Addr=${hex32(MEM_ADDR)}  Len=8DW  Tag=${rtag}`,
    'Non-Posted：消耗 NP_Hdr 1',
    () => sim.fc.consume('RC', 'NP_Hdr', 1));
  ackPair(sim, t1 + 4 * US, 'EP', 'RC', `MRd Tag=${rtag}`);
  tlpPair(sim, t1 + 12 * US, 'EP', 'RC', cpl,
    `CplD  ByteCount=0  Tag=${rtag}  Data[0]=${hex32(WRITE_DWS[0])}`,
    '读回数据与写入一致；消耗 Cpl_Hdr 1 + Cpl_Data 2',
    () => {
      sim.fc.consume('EP', 'Cpl_Hdr', 1);
      sim.fc.consume('EP', 'Cpl_Data', 2);
    });
  ackPair(sim, t1 + 16 * US, 'RC', 'EP', `CplD Tag=${rtag}`);
  dllpPair(sim, t1 + 20 * US, 'RC', 'EP',
    buildFcDllp('UpdateFC', [{ cls: 'Cpl', hdr: 1, data: 2 }]),
    'UpdateFC（归还 Cpl 信用）', '',
    () => {
      sim.fc.give('EP', 'Cpl_Hdr', 1);
      sim.fc.give('EP', 'Cpl_Data', 2);
    });
  dllpPair(sim, t1 + 28 * US, 'EP', 'RC',
    buildFcDllp('UpdateFC', [{ cls: 'NP', hdr: 1, data: 0 }]),
    'UpdateFC（归还 NP_Hdr）', '',
    () => sim.fc.give('RC', 'NP_Hdr', 1));

  sim.at(t1 + 38 * US, () => {
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'DONE',
      summary: '写后读回一致：MWr 32B → CplD 32B',
      detail: 'MWr 为 Posted（无 Completion）；读回由独立 MRd 触发',
      status: 'ok',
    });
    sim.endPhase();
  });

  sim.durationNs = (t1 + 50 * US) * 1.05;
  return {
    gen,
    width,
    durationNs: sim.durationNs,
    totalSteps: sim.pending,
    rows: sim.rows,
    defaultRow: null,
  };
}
