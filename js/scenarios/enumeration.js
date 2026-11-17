/**
 * 场景：设备枚举（M2）。
 *
 * 流程：
 *  1. 读取 Vendor/Device ID、Class Code、Header Type
 *  2. BAR 探测（写全 1 读回大小）→ 分配 64bit BAR0 / 32bit BAR2
 *  3. 置 Command.Memory Space Enable 并回读
 *
 * 说明：链路已在 L0；TLP 在 RC.TL / EP.TL 之间传输，DLL 行展示 Ack。
 */
import { buildCfg, buildCpl, bdfText } from '../core/tlp.js';
import { buildDllp } from '../core/dllp.js';
import { byteTimeNs } from '../core/packet.js';

const US = 1000;
const BDF = 0x0100; // 01:00.0
const RC_ID = 0x0000;
const EP_ID = 0x0100;

function hex(v, digits = 8) {
  return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(digits, '0');
}

function offText(reg) {
  return '0x' + reg.toString(16).toUpperCase().padStart(2, '0');
}

export function buildEnumeration(sim, opts = {}) {
  const gen = opts.gen ?? 3;
  const width = opts.width ?? 8;
  const link = sim.link;

  link.configure({ gen, width, mode: 'auto' });
  link.reset();
  link.linkUp = true;
  link.setRate(gen);
  link.setLaneNumbers(Array.from({ length: width }, (_, i) => i));
  sim.phy.stabilizeRefClk();
  sim.phy.lockPll();
  sim.phy.cdrBitLock();
  sim.phy.setOperatingRate(gen);
  sim.phy.setEqPhase(gen >= 3 ? 3 : 0, gen >= 3 ? 10 : 0);

  sim.rows = [
    { key: 'STATE', label: 'LTSSM 状态' },
    { key: 'RC.TL', label: 'RC · TL' },
    { key: 'RC.DLL', label: 'RC · DLL' },
    { key: 'EP.DLL', label: 'EP · DLL' },
    { key: 'EP.TL', label: 'EP · TL' },
  ];

  const tlpNs = (pkt) => byteTimeNs(gen, width, pkt.bytes.length);
  const ack = buildDllp('Ack');
  let cur = 0;
  let tag = 0;

  function tlpAt(t, side, dir, pkt, summary, detail = '') {
    sim.at(t, () => {
      sim.emit({
        layer: 'TL',
        row: `${side}.TL`,
        side,
        dir,
        type: pkt.name,
        summary,
        detail,
        packet: pkt,
        dur_ns: tlpNs(pkt),
        status: 'ok',
      });
    });
  }

  function ackAt(t, side, dir, label) {
    sim.at(t, () => {
      sim.emit({
        layer: 'DLL',
        row: `${side}.DLL`,
        side,
        dir,
        type: 'ACK',
        summary: `${side} ${dir === 'TX' ? '发送' : '接收'} Ack（确认 ${label}）`,
        packet: ack,
        dur_ns: 4 * US,
        status: 'ok',
      });
    });
  }

  function cfgRead(reg, label, note = '') {
    const t0 = cur;
    const myTag = tag++ & 0xff;
    const req = buildCfg({
      write: false, bdf: BDF, reg, requester: RC_ID, tag: myTag,
    });
    tlpAt(t0, 'RC', 'TX', req, `RC → EP  CfgRd0  ${label}`,
      `BDF=${bdfText(BDF)}  Reg=${offText(reg)}  Tag=${myTag}${note ? ` · ${note}` : ''}`);
    tlpAt(t0 + 2 * US, 'EP', 'RX', req, `EP 接收 CfgRd0  ${label}`);
    ackAt(t0 + 4 * US, 'EP', 'TX', `CfgRd0 Tag=${myTag}`);
    ackAt(t0 + 6 * US, 'RC', 'RX', `CfgRd0 Tag=${myTag}`);

    sim.at(t0 + 8 * US, () => {
      const value = sim.config.read(reg, 4) >>> 0;
      const cpl = buildCpl({
        requester: RC_ID, completer: EP_ID, tag: myTag, dataDws: [value], byteCount: 4,
      });
      tlpAt(t0 + 8 * US, 'EP', 'TX', cpl,
        `EP → RC  CplD  ${label} = ${hex(value)}`,
        `Status=SC  ByteCount=4  Tag=${myTag}`);
      tlpAt(t0 + 10 * US, 'RC', 'RX', cpl, `RC 接收 CplD  ${label} = ${hex(value)}`);
      ackAt(t0 + 12 * US, 'RC', 'TX', `CplD Tag=${myTag}`);
      ackAt(t0 + 14 * US, 'EP', 'RX', `CplD Tag=${myTag}`);
    });

    cur = t0 + 36 * US;
  }

  function cfgWrite(reg, value, label, note = '') {
    const t0 = cur;
    const myTag = tag++ & 0xff;
    const req = buildCfg({
      write: true, bdf: BDF, reg, requester: RC_ID, tag: myTag, data: value,
    });
    tlpAt(t0, 'RC', 'TX', req, `RC → EP  CfgWr0  ${label}`,
      `BDF=${bdfText(BDF)}  Reg=${offText(reg)}  Data=${hex(value)}  Tag=${myTag}${note ? ` · ${note}` : ''}`);
    tlpAt(t0 + 2 * US, 'EP', 'RX', req, `EP 接收 CfgWr0  ${label}`);
    ackAt(t0 + 4 * US, 'EP', 'TX', `CfgWr0 Tag=${myTag}`);
    ackAt(t0 + 6 * US, 'RC', 'RX', `CfgWr0 Tag=${myTag}`);
    sim.at(t0 + 3 * US, () => sim.config.write(reg, value, 4));
    cur = t0 + 24 * US;
  }

  // ---------- 链路基线 ----------
  sim.at(0, () => {
    sim.beginPhase('enum-probe', '枚举探测', 'enum', '读取 Vendor/Device ID、Class Code、Header Type');
    link.setBoth('L0', 'RC / EP：L0（链路已训练）', '枚举开始前链路已处于正常工作状态');
  });
  cur = 24 * US;

  cfgRead(0x00, 'Vendor / Device ID', '0x00');
  cfgRead(0x08, 'Revision / Class Code', '0x08');
  cfgRead(0x0c, 'Header Type', '0x0C');

  // ---------- BAR 探测与分配 ----------
  sim.at(cur, () => sim.beginPhase('enum-bars', 'BAR 探测与分配', 'enum', '写全 1 读回大小，再写入基址'));
  cfgWrite(0x10, 0xffffffff, 'BAR0 写全 1（探测大小）', '64bit BAR 低半');
  cfgRead(0x10, 'BAR0 低 32 位掩码');
  cfgRead(0x14, 'BAR0 高 32 位掩码');
  cfgWrite(0x10, 0x80000000, 'BAR0 低 32 位基址');
  cfgWrite(0x14, 0x00000000, 'BAR0 高 32 位基址');
  cfgRead(0x10, 'BAR0 回读');

  cfgWrite(0x18, 0xffffffff, 'BAR2 写全 1（探测大小）', '32bit BAR');
  cfgRead(0x18, 'BAR2 掩码');
  cfgWrite(0x18, 0x90000000, 'BAR2 基址');
  cfgRead(0x18, 'BAR2 回读');

  // ---------- 使能 Memory Space ----------
  sim.at(cur, () => sim.beginPhase('enum-enable', '使能 Memory Space', 'enum', '写 Command 寄存器 bit1'));
  cfgWrite(0x04, 0x0002, 'Command = 0x0002', 'Memory Space Enable');
  cfgRead(0x04, 'Command 回读');

  sim.at(cur, () => {
    sim.emit({
      layer: 'STATE',
      row: 'STATE',
      side: null,
      dir: '-',
      type: 'ENUM',
      summary: '枚举完成：BAR 已分配，Memory Space 已使能',
      detail: 'BAR0=0x0000000080000000（4KB，64bit），BAR2=0x0000000090000000（16KB），Command=0x0002',
      status: 'ok',
    });
    sim.endPhase();
  });

  sim.durationNs = cur * 1.08;
  return {
    gen,
    width,
    mode: link.flitMode ? 'flit' : 'nonflit',
    flitMode: link.flitMode,
    durationNs: sim.durationNs,
    totalSteps: sim.pending,
    rows: sim.rows,
    defaultRow: null,
  };
}
