import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, throughputAttainment } from '../js/perf/budget.js';
import { configFor, completions, flowSpecs, operations, linkCapacity, profile, rcBridgePreset, split } from '../js/perf/model.js';
import { simulate } from '../js/perf/simulate.js';
import { rttBreakdowns } from '../js/perf/rtt-breakdown.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} vs ${expected}`);

test('link accounting, aligned TLP prefix, and legal Completion boundaries', () => {
  near(linkCapacity(configFor({ gen: 4, lanes: 8, nfmAvailability: 1 })).budgetGBps, 16 * 128 / 130);
  near(linkCapacity(configFor({ gen: 6, lanes: 16 })).budgetGBps, 118);
  assert.deepEqual(split(4092, 520, 512).map(part => part.bytes), [4, 512, 4]);
  assert.deepEqual(completions({ address: 4, bytes: 512 }, configFor()), [252, 256, 4]);
});

test('CMN system interconnect defaults to 64 GB/s and is configurable', () => {
  assert.equal(configFor().cmnBandwidthGBps, 64);
  assert.equal(analyze([{ scenario: 'ep-ddr', readPct: 50, count: 2 }]).model.cmnBandwidthGBps, 64);
  const constrained = analyze([{ scenario: 'host-dma', readPct: 50, count: 32 }], { cmnBandwidthGBps: 8 });
  assert.equal(constrained.model.cmnBandwidthGBps, 8);
  assert.ok(constrained.bounds.some(item => item.id === 'host.CMN' && item.maxUsefulGBps < 16));
  assert.throws(() => configFor({ cmnBandwidthGBps: 0 }), /cmnBandwidthGBps/);
});

test('RC Bridge presets separate AXI physical peak from effective capacity', () => {
  assert.deepEqual(rcBridgePreset(6, 16), {
    widthBits: 1024, clockGHz: 1, interfacePeakGBps: 128, bandwidthGBps: 64,
  });
  assert.deepEqual([rcBridgePreset(6, 8), rcBridgePreset(5, 8), rcBridgePreset(5, 16)]
    .map(item => [item.widthBits, item.bandwidthGBps]), [[512, 64], [256, 32], [512, 64]]);
  const preset = configFor({ gen: 6, lanes: 16 });
  assert.equal(profile(preset, 'rc.AXI').interfacePeakGBps, 128);
  assert.equal(profile(preset, 'rc.AXI').bandwidth, 64);
  const budget = analyze([{ scenario: 'ep-ddr', readPct: 50, count: 2 }], { gen: 6, lanes: 16 });
  assert.equal(budget.rcBridge.widthBits, 1024);
  assert.equal(budget.rcBridge.clockGHz, 1);
  assert.equal(budget.rcBridge.interfacePeakGBps, 128);
  assert.equal(budget.rcBridge.effectiveGBps, 64);
  const custom = configFor({ rcAxiWidthBits: 384, rcAxiClockGHz: 1.25, rcBridgeBandwidthGBps: 48 });
  assert.equal(profile(custom, 'rc.AXI').bandwidth, 48);
  assert.throws(() => configFor({ rcAxiWidthBits: 256, rcAxiClockGHz: 1, rcBridgeBandwidthGBps: 64 }),
    /rcBridgeBandwidthGBps/);
});

test('byte-weighted mix uses sixteen small writes per large read', () => {
  const [flow] = flowSpecs([{ readBytes: 4096, writeBytes: 256, count: 17, readPct: 50 }]);
  const ops = [...operations(flow)];
  assert.equal(ops.filter(op => op.kind === 'read').length, 1);
  assert.equal(ops.filter(op => op.kind === 'write').length, 16);
});

test('ideal throughput uses directional wire cost and attainment requires a complete batch', () => {
  const specs = [{ count: 32, readPct: 50 }];
  const model = { tags: 1, nfmAvailability: 1 };
  const budget = analyze(specs, model);
  const report = simulate(specs, model, { traceOps: 0 });
  near(budget.idealGBps, (16 * 128 / 130) * 1024 / (24 + 2 * 280));
  assert.equal(budget.idealConstraint, 'epA>rc');
  assert.deepEqual(budget.idealDirections.map(item => [item.id, item.requestBytes, item.writeBytes, item.completionBytes]), [
    ['epA>rc', 16 * 24, 32 * 280, 0], ['rc>epA', 0, 0, 32 * 276],
  ]);
  assert.ok(budget.upperGBps < budget.idealGBps);
  const hit = throughputAttainment(budget, report);
  near(hit.idealPct, 100 * report.batchGBps / budget.idealGBps);
  near(hit.upperPct, 100 * report.batchGBps / budget.upperGBps);
  assert.equal(throughputAttainment(budget, simulate(specs, model, { maxEvents: 1 })), null);
  assert.equal(throughputAttainment(budget, null), null);
});

test('all paths and ratios drain, conserve bytes & credit, and stay below aggregate bounds', () => {
  for (const scenario of ['ep-ddr', 'cpu-bar', 'host-dma', 'p2p', 'p2p-reverse']) {
    for (const readPct of [0, 25, 50, 75, 100]) {
      const specs = [{ scenario, readPct, count: 32 }];
      const model = { gen: 5 };
      const budget = analyze(specs, model);
      const sim = simulate(specs, model, { traceOps: 0 });
      const [flow] = sim.flows;
      assert.equal(sim.stopReason, 'complete');
      assert.deepEqual(flow.completed, flow.submitted);
      assert.equal(flow.accepted.write, flow.completed.write);
      near(flow.completedReadPct, readPct);
      assert.ok(sim.batchGBps <= budget.upperGBps + 1e-8, `${scenario} ${readPct}`);
      assert.ok(sim.resources.every(pool => pool.used === 0 && pool.peak <= pool.capacity && pool.claims === pool.released));
      if (scenario.startsWith('p2p')) assert.ok(sim.resources.every(pool => !pool.id.includes('host.') && !pool.id.includes('rc')));
    }
  }
});

test('512B EP read follows hand-calculated one-packet request and split Completion timeline', () => {
  const specs = [{ scenario: 'ep-ddr', readPct: 100, count: 1 }];
  const sim = simulate(specs, { nfmAvailability: 1 });
  const rate = 16 * 128 / 130;
  const fixed = 18 * 2 + 12 * 2 + 5 + 12 + 28;
  const cycle = 2 / 64 + 2 / 128 + 1 / rate + 1 / 32 + 1 / 64;
  const request = fixed + 24 * cycle;
  const reply = fixed + 276 * cycle;
  const service = 95 + 512 / 32;
  const secondSerialization = 276 / rate;
  const expectedFirst = 20 + 12 + request + service + reply;
  near(sim.flows[0].firstCompletionNs.p50, expectedFirst);
  near(sim.flows[0].readNs.p50, expectedFirst + secondSerialization + 12 + 512 / 32);
  const wireFirst = request + service + reply - (18 + 12 + 24 / 64 + 24 / 128) -
    (18 + 12 + 276 / 64 + 276 / 128);
  const [flow] = sim.flows;
  near(flow.readRtt.firstNs.p50, wireFirst);
  near(flow.readRtt.lastNs.p50, wireFirst + secondSerialization);
  near(flow.tagHoldNs.p50, flow.meanTagHoldNs);
  assert.ok(flow.tagHoldNs.p50 > flow.readRtt.lastNs.p50);
  assert.equal(flow.readRtt.lastSamples, 1);
  const start = sim.trace.find(item => item.event === 'mrd-tx-start');
  const ends = sim.trace.filter(item => item.event === 'cpl-rx-end' && item.txnId === start.txnId);
  assert.equal(ends.length, 2);
  near(ends.at(-1).atNs - start.atNs, flow.readRtt.lastNs.p50);
  const [breakdown] = rttBreakdowns(sim.trace, 'host.DDR');
  near(breakdown.phases.reduce((sum, phase) => sum + phase.ns, 0), flow.readRtt.lastNs.p50);
  near(breakdown.phases[1].ns, service);
  near(breakdown.phases[3].ns, secondSerialization);
  assert.deepEqual(rttBreakdowns(sim.trace.filter(event => event !== ends.at(-1)), 'host.DDR'), []);
  const fragments = sim.trace.filter(item => item.event === 'completion-arrived');
  const freed = sim.trace.find(item => item.event === 'release' && item.resource === 'epA:tags');
  assert.deepEqual(fragments.map(item => [item.tag, item.bytes]), [[0, 256], [0, 256]]);
  assert.equal(freed.atNs, fragments[1].atNs);
  const accepted = simulate([{ ...specs[0], readPct: 0 }]).flows[0];
  assert.ok(accepted.writeAcceptedNs.p50 < accepted.writeVisibleNs.p50);
  assert.equal(accepted.readRtt.lastNs.p50, null);
  const singleWrite = simulate([{ readPct: 0, count: 1, writeBytes: 256 }], { nfmAvailability: 1 }).flows[0];
  near(singleWrite.writeVisibleNs.p50, 20 + 12 + 256 / 32 + fixed + 280 * cycle + 95 + 256 / 24);
});

test('Tag, AXI, posted credit, and DDR bottlenecks are independently reproducible', () => {
  for (const [model, readPct, id] of [
    [{ tags: 1 }, 100, 'epA:tags'],
    [{ axiRead: 1 }, 100, 'epA:axi-read'],
    [{ creditData: 16, creditReturnNs: 400 }, 0, 'epA>rc:P:data'],
    [{ nodes: { 'host.DDR': { writeGBps: 1 } } }, 0, 'host.DDR'],
  ]) {
    const specs = [{ count: 64, readPct }];
    const report = simulate(specs, model, { traceOps: 0 });
    assert.equal(report.stopReason, 'complete');
    const budget = analyze(specs, model);
    assert.equal(budget.bounds[0].id, id);
    assert.ok(report.batchGBps < simulate(specs, {}, { traceOps: 0 }).batchGBps);
    const resource = report.resources.find(pool => pool.id === id);
    assert.ok(resource.waitNs > 0);
    assert.equal(resource.claims, resource.released);
  }
});

test('dual-ended write and reverse read share the same physical wire; routing is explicit', () => {
  const flows = [{ scenario: 'p2p', readPct: 0, count: 8 }, { scenario: 'p2p-reverse', readPct: 100, count: 8 }];
  const model = { gen: 4 };
  const report = simulate(flows, model);
  assert.deepEqual(report, simulate(flows, model));
  const wires = Object.fromEntries(report.resources.filter(pool => /^\w+>\w+$/.test(pool.id))
    .map(pool => [pool.id, pool.bytes]));
  assert.equal(wires['epA>sw'], 16 * (280 + 276));
  assert.equal(wires['sw>epA'], 8 * 24);
  const shared = report.resources.find(pool => pool.id === 'epA>sw');
  near(shared.measuredBytes, wires['epA>sw']);
  assert.ok(shared.measuredUtilization <= 1);
  assert.throws(() => simulate(flows, { p2p: 'acs-redirect' }), /does not assume Root forwarding/);
  assert.throws(() => simulate(flows, { gen: 6 }), /budget mode only/);
});

test('visible-serial delays a dependent read until the preceding write is visible', () => {
  const specs = [{ count: 3, readPct: 50, readOffset: 512, writeOffset: 1024, order: 'visible-serial' }];
  const sim = simulate(specs, {}, { traceOps: 3 });
  const visible = sim.trace.find(item => item.opId === 'flow1:1' && item.event === 'target-visible');
  const read = sim.trace.find(item => item.opId === 'flow1:2' && item.event === 'tag-allocated');
  assert.ok(read.atNs >= visible.atNs);
  assert.ok(sim.batchGBps <= analyze(specs).upperGBps + 1e-8);
});

test('measurement window and partial execution distinguish issued from completed', () => {
  const specs = [{ count: 3, readPct: 100, intervalNs: 1000 }];
  const report = simulate(specs, {}, { startNs: 1000, endNs: 2000 });
  assert.equal(report.sampleNs, 1000);
  assert.equal(report.flows[0].measured.read, 512);
  assert.equal(report.flows[0].sampleCounts.read, 1);
  near(report.throughput.readGBps, 0.512);
  const idle = simulate([{ count: 1, readPct: 100 }], {}, { endNs: 2000 });
  near(idle.throughput.readGBps, 0.256);
  const short = simulate([{ count: 1, readPct: 100 }], {}, { endNs: 100 });
  assert.equal(short.throughput.readGBps, 0);
  assert.equal(short.flows[0].readRtt.lastSamples, 1);
  const cut = simulate(specs, {}, { maxEvents: 1 });
  assert.equal(cut.stopReason, 'event-limit');
  assert.equal(cut.flows[0].issued.read, 512);
  assert.equal(cut.flows[0].completed.read, 0);
  assert.equal(cut.flows[0].sampleCounts.incompleteRead, 1);
});
