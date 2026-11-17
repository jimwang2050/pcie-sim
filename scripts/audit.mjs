// Read-only audit probes. Reports observations; does not certify PCIe compliance.
import { resolveScenarioConfig } from '../js/scenarios/registry.js';
import { Sim } from '../js/core/sim.js';
import { ConfigSpace } from '../js/core/config.js';
import { FlowControl } from '../js/core/fc.js';
import { BertModel } from '../js/core/bert.js';
import { Scheduler } from '../js/core/scheduler.js';
import { buildCfg, buildMem } from '../js/core/tlp.js';
import { buildFlit, checkFlit } from '../js/core/flit.js';
import { buildFlitGen6 } from '../js/scenarios/flit_gen6.js';

const scenarios = {
  link_training: 'buildLinkTraining', enumeration: 'buildEnumeration',
  ltssm_pm: 'buildLtssmPm', phy_link: 'buildPhyLink',
  flit_gen6: 'buildFlitGen6', loopback_bert: 'buildLoopbackBert',
  mem_read: 'buildMemRead', mem_write: 'buildMemWrite',
  msi_int: 'buildMsiInt', aer_error: 'buildAerError',
  dpc_rpio: 'buildDpcRpio', ats: 'buildAts', pm_dp: 'buildPmDp',
};
const report = { scope: 'Local Node model probes; no browser or compliance validation', matrix: { runs: 0, supported: 0, rejectedAsUnsupported: 0, failures: [] }, probes: {} };
for (const [file, name] of Object.entries(scenarios)) {
  const build = (await import(`../js/scenarios/${file}.js`))[name];
  for (const gen of [1, 2, 3, 4, 5, 6]) {
    for (const width of [1, 2, 4, 8, 16]) {
      report.matrix.runs++;
      let supported = true;
      try { resolveScenarioConfig(file, { gen, width }); } catch { supported = false; }
      if (!supported) {
        const rejected = new Sim();
        try { build(rejected, { gen, width }); report.matrix.failures.push({ scenario: file, gen, width, message: 'Unsupported input accepted' }); }
        catch (error) { if (!(error instanceof RangeError)) throw error; report.matrix.rejectedAsUnsupported++; }
        continue;
      }
      report.matrix.supported++;
      try {
        const s = new Sim(); s.reset({ gen, width }); build(s, { gen, width }); s.runToEnd();
        if (s.pending) throw new Error('Queue not exhausted');
        if (!s.events.length) throw new Error('No events');
        let last = -Infinity;
        for (const e of s.events) {
          if (!Number.isFinite(e.t_ns) || e.t_ns < last) throw new Error('Invalid event time');
          last = e.t_ns;
        }
      } catch (error) {
        report.matrix.failures.push({ scenario: file, gen, width, message: error.message });
      }
    }
  }
}

const s = new Sim(); s.reset({ gen: 6, width: 8 }); buildFlitGen6(s, {});
while (s.clock < 22000) s.stepOnce();
const original = structuredClone(s.events.at(-1));
while (s.clock < 40000) s.stepOnce();
while (s.clock >= 22000) s.stepBack();
s.stepOnce();
report.probes.partialReplay = {
  equal: JSON.stringify(original) === JSON.stringify(s.events.at(-1)),
  originalCheck: original.packet.check, replayedCheck: s.events.at(-1).packet.check,
};
const cfg = new ConfigSpace(); cfg.write16Raw(6, 0xaabb); cfg.write(4, 2, 2);
report.probes.config = { statusAfter16BitCommandWrite: cfg.readRaw(6, 2), bar0TypeBits: cfg.read(0x10) & 0xf };
const fc = new FlowControl(); fc.init({ header: 1 });
report.probes.creditOverdraw = { requested: 2, availableBefore: 1, result: fc.consume('RC', 'NP_Hdr', 2) };
const bert = new BertModel(); bert.start(); bert.lock();
report.probes.bert = { bits: bert.bits, pass: bert.pass };
const scheduler = new Scheduler(); scheduler.at(100, () => {}); scheduler.step();
let rejectedPastEvent = false;
try { scheduler.at(10, () => {}); } catch (error) { rejectedPastEvent = error instanceof RangeError; }
report.probes.schedulerPastEvent = { rejectedPastEvent, previousTime: 100, newTime: scheduler.time };
const flit = buildFlit(); flit.bytes[0] ^= 1;
report.probes.corruptedFlitWithoutErrorHint = checkFlit(flit);
for (const [name, packet] of Object.entries({
  cfgRead: buildCfg({ requester: 0x1234, bdf: 0x0100, tag: 0x56, reg: 0x10 }),
  memoryRead: buildMem({ requester: 0x1234, tag: 0x56, address: 0x80001000, lengthDw: 32 }),
})) {
  const view = new DataView(Uint8Array.from(packet.bytes).buffer);
  report.probes[name] = { dwordsInInternalByteOrder: Array.from({ length: 3 }, (_, i) => `0x${view.getUint32(i * 4, true).toString(16).padStart(8, '0')}`) };
}
console.log(JSON.stringify(report, null, 2));
