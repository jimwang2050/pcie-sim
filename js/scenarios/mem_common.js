/**
 * 内存读写场景的公共设置与事件辅助。
 */
import { buildDllp } from '../core/dllp.js';
import { buildFcDllp } from '../core/fc.js';
import { byteTimeNs } from '../core/packet.js';

export const US = 1000;
export const MEM_ADDR = 0x80001000;
export const RC_ID = 0x0000;
export const EP_ID = 0x0100;

export function setupLinkL0(sim, gen, width, rows) {
  const link = sim.link;
  link.configure({ gen, width, mode: 'auto' });
  link.reset();
  link.linkUp = true;
  link.setRate(gen);
  link.setLaneNumbers(Array.from({ length: width }, (_, i) => i));

  sim.phy.reset(gen, width);
  sim.phy.stabilizeRefClk();
  sim.phy.lockPll();
  sim.phy.cdrBitLock();
  sim.phy.setOperatingRate(gen);
  sim.phy.setEqPhase(gen >= 3 ? 3 : 0, gen >= 3 ? sim.phy.bestPreset() : 0);

  sim.rows = rows;
}

export function setupMemScenario(sim, gen, width, credits = {}) {
  const { header = 8, data = 32, cplData = 64 } = credits;
  const link = sim.link;
  link.configure({ gen, width, mode: 'auto' });
  link.reset();
  link.linkUp = true;
  link.setRate(gen);
  link.setLaneNumbers(Array.from({ length: width }, (_, i) => i));

  sim.phy.reset(gen, width);
  sim.phy.stabilizeRefClk();
  sim.phy.lockPll();
  sim.phy.cdrBitLock();
  sim.phy.setOperatingRate(gen);
  sim.phy.setEqPhase(gen >= 3 ? 3 : 0, gen >= 3 ? sim.phy.bestPreset() : 0);

  sim.fc.reset();
  sim.fc.init({ header, data, cplData });
  sim.tx.reset();
  sim.mem.reset();

  sim.rows = [
    { key: 'STATE', label: 'LTSSM 状态' },
    { key: 'RC.TL', label: 'RC · TL' },
    { key: 'RC.DLL', label: 'RC · DLL' },
    { key: 'EP.DLL', label: 'EP · DLL' },
    { key: 'EP.TL', label: 'EP · TL' },
  ];
}

export function tlpPair(sim, t, from, to, pkt, label, detail = '', onTx = null, eventType = null, status = 'ok') {
  const dur = byteTimeNs(sim.link.gen, sim.link.width, pkt.bytes.length);
  const type = eventType || pkt.name;
  sim.at(t, () => {
    if (onTx) onTx();
    sim.emit({
      layer: 'TL',
      row: `${from}.TL`,
      side: from,
      dir: 'TX',
      type,
      summary: `${from} → ${to} ${label}`,
      detail,
      packet: pkt,
      dur_ns: dur,
      status,
    });
  });
  sim.at(t + 2 * US, () => {
    sim.emit({
      layer: 'TL',
      row: `${to}.TL`,
      side: to,
      dir: 'RX',
      type,
      summary: `${to} 接收 ${label}`,
      packet: pkt,
      dur_ns: dur,
      status,
    });
  });
}

export function dllpPair(sim, t, from, to, pkt, label, detail = '', onTx = null) {
  const dur = 4 * US;
  sim.at(t, () => {
    if (onTx) onTx();
    sim.emit({
      layer: 'DLL',
      row: `${from}.DLL`,
      side: from,
      dir: 'TX',
      type: pkt.name,
      summary: `${from} → ${to} ${label}`,
      detail,
      packet: pkt,
      dur_ns: dur,
      status: 'ok',
    });
  });
  sim.at(t + 2 * US, () => {
    sim.emit({
      layer: 'DLL',
      row: `${to}.DLL`,
      side: to,
      dir: 'RX',
      type: pkt.name,
      summary: `${to} 接收 ${label}`,
      packet: pkt,
      dur_ns: dur,
      status: 'ok',
    });
  });
}

export function ackPair(sim, t, from, to, label) {
  const pkt = buildDllp('Ack');
  pkt.name = 'ACK';
  dllpPair(sim, t, from, to, pkt, `Ack（${label}）`);
}

function creditList(side, fc) {
  const l = fc.limits[side];
  return [
    { cls: 'P', hdr: l.P_Hdr, data: l.P_Data },
    { cls: 'NP', hdr: l.NP_Hdr, data: l.NP_Data },
    { cls: 'Cpl', hdr: l.Cpl_Hdr, data: l.Cpl_Data },
  ];
}

/** InitFC1 / InitFC2 握手，返回结束时间（ns）。 */
export function fcInit(sim, tStart) {
  const fc = sim.fc;
  let t = tStart;
  dllpPair(sim, t, 'RC', 'EP', buildFcDllp('InitFC1', creditList('RC', fc)),
    'InitFC1（通告 P/NP/Cpl 初始信用）');
  t += 8 * US;
  dllpPair(sim, t, 'EP', 'RC', buildFcDllp('InitFC1', creditList('EP', fc)),
    'InitFC1（反方向）');
  t += 8 * US;
  dllpPair(sim, t, 'RC', 'EP', buildFcDllp('InitFC2', creditList('RC', fc)),
    'InitFC2（确认初始信用）');
  t += 8 * US;
  dllpPair(sim, t, 'EP', 'RC', buildFcDllp('InitFC2', creditList('EP', fc)),
    'InitFC2（确认，流控初始化完成）', '', () => { fc.initDone = true; });
  return t + 8 * US;
}
