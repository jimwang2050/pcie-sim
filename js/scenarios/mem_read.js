import { resolveScenarioConfig } from './registry.js';
/**
 * 场景：内存读（MRd → CplD，Split Transaction）。
 * 128B 读按 RCB=64B 拆成两个 CplD；展示 Tag 匹配、Cpl 信用与 UpdateFC。
 */
import { buildMem, buildCpl, hex32 } from '../core/tlp.js';
import { buildFcDllp } from '../core/fc.js';
import {
  setupMemScenario, fcInit, tlpPair, ackPair, dllpPair,
  MEM_ADDR, RC_ID, EP_ID, US,
} from './mem_common.js';

export function buildMemRead(sim, opts = {}) {
  resolveScenarioConfig('mem_read', opts);
  const gen = opts.gen ?? 3;
  const width = opts.width ?? 8;
  setupMemScenario(sim, gen, width);

  sim.at(0, () => sim.beginPhase('fc-init', '流控初始化', 'pm',
    'InitFC1 / InitFC2 交换 P / NP / Cpl 初始信用'));
  const tAfter = fcInit(sim, 16 * US);
  sim.at(tAfter, () => sim.beginPhase('read', '内存读 MRd → CplD', 'enum',
    '教学案例：对齐的 128B 读选择两个 64B Completion，满足所选 RCB=64B（并非强制拆包）'));

  const t0 = tAfter + 12 * US;
  const tag = 1;
  const req = buildMem({
    write: false, address: MEM_ADDR, is64: true, lengthDw: 32, requester: RC_ID, tag,
  });
  const dws = sim.mem.readDws(MEM_ADDR, 32);
  const cpl1 = buildCpl({
    requester: RC_ID, completer: EP_ID, tag,
    dataDws: dws.slice(0, 16), byteCount: 128, lowerAddress: 0,
  });
  const cpl2 = buildCpl({
    requester: RC_ID, completer: EP_ID, tag,
    dataDws: dws.slice(16), byteCount: 64, lowerAddress: 0x40,
  });

  tlpPair(sim, t0, 'RC', 'EP', req,
    `MRd  Addr=${hex32(MEM_ADDR)}  Len=32DW  Tag=${tag}`,
    'Non-Posted：消耗 NP_Hdr 1；Tag 用于匹配 Completion',
    () => sim.fc.consume('RC', 'NP_Hdr', 1));
  ackPair(sim, t0 + 4 * US, 'EP', 'RC', `MRd Tag=${tag}`);

  tlpPair(sim, t0 + 10 * US, 'EP', 'RC', cpl1,
    `CplD  ByteCount=128  Tag=${tag}  Data[0]=${hex32(dws[0])}`,
    '第 1 个 64B Completion（RCB=64B）；消耗 Cpl_Hdr 1 + Cpl_Data 4',
    () => {
      sim.fc.consume('EP', 'Cpl_Hdr', 1);
      sim.fc.consume('EP', 'Cpl_Data', 4);
    });
  ackPair(sim, t0 + 14 * US, 'RC', 'EP', `CplD Tag=${tag}`);
  dllpPair(sim, t0 + 18 * US, 'RC', 'EP',
    buildFcDllp('UpdateFC', [{ cls: 'Cpl', hdr: 1, data: 4 }]),
    'UpdateFC（归还 Cpl 信用）',
    'RC 释放 Completion 缓冲区，归还 Cpl_Hdr 1 / Cpl_Data 4',
    () => {
      sim.fc.give('EP', 'Cpl_Hdr', 1);
      sim.fc.give('EP', 'Cpl_Data', 4);
    });

  tlpPair(sim, t0 + 26 * US, 'EP', 'RC', cpl2,
    `CplD  ByteCount=64  Tag=${tag}  Data[0]=${hex32(dws[16])}`,
    '第 2 个 64B Completion，Lower Address=0x40',
    () => {
      sim.fc.consume('EP', 'Cpl_Hdr', 1);
      sim.fc.consume('EP', 'Cpl_Data', 4);
    });
  ackPair(sim, t0 + 30 * US, 'RC', 'EP', `CplD Tag=${tag}`);
  dllpPair(sim, t0 + 34 * US, 'RC', 'EP',
    buildFcDllp('UpdateFC', [{ cls: 'Cpl', hdr: 1, data: 4 }]),
    'UpdateFC（归还 Cpl 信用）', '',
    () => {
      sim.fc.give('EP', 'Cpl_Hdr', 1);
      sim.fc.give('EP', 'Cpl_Data', 4);
    });
  dllpPair(sim, t0 + 42 * US, 'EP', 'RC',
    buildFcDllp('UpdateFC', [{ cls: 'NP', hdr: 1, data: 0 }]),
    'UpdateFC（归还 NP_Hdr）',
    'EP 处理完 MRd，归还 NP_Hdr 1',
    () => sim.fc.give('RC', 'NP_Hdr', 1));

  sim.at(t0 + 52 * US, () => {
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'DONE',
      summary: '内存读完成：2 个 CplD，Tag 1 匹配，信用已归还',
      detail: '128B 数据来自 EP 内存 0x1000；RCB=64B 决定 Completion 拆分粒度',
      status: 'ok',
    });
    sim.endPhase();
  });

  sim.durationNs = (t0 + 64 * US) * 1.05;
  return {
    gen,
    width,
    durationNs: sim.durationNs,
    totalSteps: sim.pending,
    rows: sim.rows,
    defaultRow: null,
  };
}
