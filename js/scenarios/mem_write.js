import { resolveScenarioConfig } from './registry.js';
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
  resolveScenarioConfig('mem_write', opts);
  const gen = opts.gen ?? 3;
  const width = opts.width ?? 8;
  // 只通告 2 个 Data 信用（32B），用于演示信用耗尽后的阻塞与重发。
  setupMemScenario(sim, gen, width, { data: 2 });

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
    'Posted：无 Completion；原子扣减 P_Hdr 1 + P_Data 2（32B / 16B）',
    () => sim.fc.reserve('RC', { P_Hdr: 1, P_Data: 2 }));
  ackPair(sim, t0 + 4 * US, 'EP', 'RC', `MWr Tag=${tag}`);
  sim.at(t0 + 3 * US, () => sim.mem.writeDws(MEM_ADDR, WRITE_DWS));

  // ---------- 信用不足：阻塞而不是负信用 ----------
  const mwr2 = buildMem({
    write: true, address: MEM_ADDR + 0x20, is64: true, lengthDw: 4,
    requester: RC_ID, tag: 0, dataDws: [0x11112222, 0x33334444, 0x55556666, 0x77778888],
  });
  const need2 = { P_Hdr: 1, P_Data: 1 };
  sim.at(t0 + 5 * US, () => {
    const can = sim.fc.canSend('RC', need2);
    const r = sim.fc.reserve('RC', need2);
    sim.emit({
      layer: 'TL', row: 'RC.TL', side: 'RC', dir: 'TX', type: 'FCBLOCK',
      summary: can ? '信用足够（异常）' : 'P_Data 信用不足 → TX 阻塞，未发出第 2 个 MWr',
      detail: `可用 P_Data=${sim.fc.available.RC.P_Data}，需要 1（16B）；Header/Data 原子判定，不分开扣减`,
      status: can ? 'error' : 'idle',
    });
    return r;
  });

  dllpPair(sim, t0 + 10 * US, 'EP', 'RC',
    buildFcDllp('UpdateFC', [{ cls: 'P', hdr: 1, data: 2 }]),
    'UpdateFC（归还 P 信用）',
    'EP 将 32B 写入内存后释放缓冲区，归还 P_Hdr 1 / P_Data 2',
    () => sim.fc.release('RC', { P_Hdr: 1, P_Data: 2 }));

  tlpPair(sim, t0 + 12 * US, 'RC', 'EP', mwr2,
    `MWr#2  Addr=${hex32(MEM_ADDR + 0x20)}  Len=4DW  Tag=0`,
    'UpdateFC 归还后重发：同一请求只发送一次',
    () => sim.fc.reserve('RC', need2));
  ackPair(sim, t0 + 16 * US, 'EP', 'RC', 'MWr#2');
  sim.at(t0 + 15 * US, () => sim.mem.writeDws(MEM_ADDR + 0x20, [0x11112222, 0x33334444, 0x55556666, 0x77778888]));
  dllpPair(sim, t0 + 20 * US, 'EP', 'RC',
    buildFcDllp('UpdateFC', [{ cls: 'P', hdr: 1, data: 1 }]),
    'UpdateFC（归还第 2 个 MWr 的 P 信用）',
    'P_Hdr 1 / P_Data 1 归还后，发送端信用回到通告上限',
    () => sim.fc.release('RC', { P_Hdr: 1, P_Data: 1 }));

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
    dataDws: WRITE_DWS.slice(), byteCount: 32, lowerAddress: 0,
  });

  tlpPair(sim, t1, 'RC', 'EP', rd,
    `MRd  Addr=${hex32(MEM_ADDR)}  Len=8DW  Tag=${rtag}`,
    'Non-Posted：原子扣减 NP_Hdr 1',
    () => {
      sim.fc.reserve('RC', { NP_Hdr: 1 });
      sim.tx.begin({ requester: RC_ID, tag: rtag, kind: 'MRd', lengthBytes: 32, at: sim.clock });
    });
  ackPair(sim, t1 + 4 * US, 'EP', 'RC', `MRd Tag=${rtag}`);
  tlpPair(sim, t1 + 12 * US, 'EP', 'RC', cpl,
    `CplD  ByteCount=32  Tag=${rtag}  Data[0]=${hex32(WRITE_DWS[0])}`,
    '读回数据与写入一致；原子扣减 Cpl_Hdr 1 + Cpl_Data 2',
    () => sim.fc.reserve('EP', { Cpl_Hdr: 1, Cpl_Data: 2 }));
  sim.at(t1 + 14 * US, () => {
    const r = sim.tx.complete({
      requester: RC_ID, tag: rtag, byteCount: cpl.byteCount,
      dataBytes: cpl.dataBytes.length, lowerAddress: cpl.lowerAddress,
    });
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'TXMATCH',
      summary: r.ok ? `CplD 匹配 Tag ${rtag}：事务完成` : `CplD 无匹配请求（Tag ${rtag}）`,
      detail: '读回事务由 Completion 结束，Ack 只到 DLL 层',
      status: r.ok ? 'ok' : 'error',
    });
  });
  ackPair(sim, t1 + 16 * US, 'RC', 'EP', `CplD Tag=${rtag}`);
  dllpPair(sim, t1 + 20 * US, 'RC', 'EP',
    buildFcDllp('UpdateFC', [{ cls: 'Cpl', hdr: 1, data: 2 }]),
    'UpdateFC（归还 Cpl 信用）', '',
    () => sim.fc.release('EP', { Cpl_Hdr: 1, Cpl_Data: 2 }));
  dllpPair(sim, t1 + 28 * US, 'EP', 'RC',
    buildFcDllp('UpdateFC', [{ cls: 'NP', hdr: 1, data: 0 }]),
    'UpdateFC（归还 NP_Hdr）', '',
    () => sim.fc.release('RC', { NP_Hdr: 1 }));

  sim.at(t1 + 38 * US, () => {
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'DONE',
      summary: '写后读回一致：MWr 32B → CplD 32B',
      detail: `MWr 为 Posted（无 Completion）；信用阻塞 ${sim.fc.blocked.RC} 次，未出现负信用`,
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
