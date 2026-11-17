import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, WIDTHS } from '../js/scenarios/registry.js';
import { parseState, formatState } from '../js/core/url_state.js';
import { buildTraceDocument, stringifyTrace, bigintSafe, TRACE_SCHEMA_VERSION } from '../js/core/trace_export.js';
import { matchesFilter } from '../js/ui/timeline.js';
import { SCENARIO_GUIDE, GUIDE_SECTIONS } from '../js/ui/guide.js';
import { Sim } from '../js/core/sim.js';
import { buildMemRead } from '../js/scenarios/mem_read.js';

test('M3/URL：只接受允许的键，非法值忽略', () => {
  const valid = parseState('#scenario=mem_read&gen=5&width=16&mode=nonflit', { scenarios: SCENARIOS, widths: WIDTHS });
  assert.deepEqual(valid, { scenario: 'mem_read', gen: 5, width: 16, mode: 'nonflit' });

  assert.deepEqual(parseState('', { scenarios: SCENARIOS, widths: WIDTHS }), {});
  assert.deepEqual(parseState('#scenario=nope&gen=9&width=3&mode=typo', { scenarios: SCENARIOS, widths: WIDTHS }), {});
  assert.equal(parseState('#scenario=ats', { scenarios: SCENARIOS, widths: WIDTHS }).scenario, 'ats');
});

test('M3/URL：格式化后可原样解析回来', () => {
  const state = { scenario: 'aer_error', gen: 3, width: 8, mode: 'auto' };
  const parsed = parseState(formatState(state), { scenarios: SCENARIOS, widths: WIDTHS });
  assert.deepEqual(parsed, state);
  assert.ok(formatState(state).startsWith('#'));
});

test('M3/教学导引：13 个场景都有导引且各段非空', () => {
  for (const key of Object.keys(SCENARIOS)) {
    const guide = SCENARIO_GUIDE[key];
    assert.ok(guide, `缺少导引：${key}`);
    for (const [field, label] of GUIDE_SECTIONS) {
      const value = guide[field];
      assert.ok(value && value.length, `${key} 缺少「${label}」`);
      if (Array.isArray(value)) assert.ok(value.every((v) => typeof v === 'string' && v.length));
    }
  }
});

test('M3/筛选：按层、方向、状态组合过滤', () => {
  const tx = { layer: 'TL', dir: 'TX', status: 'ok' };
  const rx = { layer: 'TL', dir: 'RX', status: 'ok' };
  const err = { layer: 'DLL', dir: '-', status: 'error' };
  assert.equal(matchesFilter(tx, { layer: 'all', dir: 'all', status: 'all' }), true);
  assert.equal(matchesFilter(tx, { layer: 'TL' }), true);
  assert.equal(matchesFilter(tx, { layer: 'DLL' }), false);
  assert.equal(matchesFilter(rx, { dir: 'TX' }), false);
  assert.equal(matchesFilter(rx, { dir: 'RX' }), true);
  assert.equal(matchesFilter(err, { status: 'error' }), true);
  assert.equal(matchesFilter(err, { status: 'ok' }), false);
  assert.equal(matchesFilter(err, { layer: 'DLL', status: 'error' }), true);
});

test('M3/导出：BigInt 地址转十六进制字符串，不丢精度', () => {
  assert.deepEqual(bigintSafe({ address: 0xfedcba9876543000n }), { address: '0xFEDCBA9876543000' });
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildMemRead(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  const cfg = { gen: 3, width: 8, mode: 'nonflit' };
  const doc = buildTraceDocument({
    scenario: 'mem_read',
    config: cfg,
    effective: { gen: 3, width: 8, effectiveMode: 'nonflit', fidelity: 'behavior-subset', note: 'test' },
    durationNs: sim.durationNs,
    clockNs: sim.clock,
    events: sim.events,
    generatedAt: '2026-11-18T00:00:00.000Z',
  });
  assert.equal(doc.schemaVersion, TRACE_SCHEMA_VERSION);
  assert.equal(doc.eventCount, sim.events.length);
  assert.equal(doc.config.gen, 3);
  assert.equal(doc.timeBase.unit, 'ns');

  const text = stringifyTrace(doc);
  const round = JSON.parse(text);
  assert.equal(round.events.length, sim.events.length);
  const first = round.events[0];
  assert.equal(first.schemaVersion, TRACE_SCHEMA_VERSION);
  assert.equal(typeof first.eventId, 'number');
  assert.equal(typeof first.modelTimeNs, 'number');
  assert.ok(['model', 'schematic', 'field-model'].includes(first.fidelity));
  assert.ok('requestId' in first && 'causeId' in first);

  // 超过安全整数范围的地址必须导出为十六进制字符串
  const bigDoc = buildTraceDocument({
    scenario: 'mem_read',
    config: cfg,
    effective: null,
    durationNs: 1,
    clockNs: 0,
    events: [{
      id: 0, t_ns: 0, dur_ns: 0, layer: 'TL', row: 'RC.TL', side: 'RC', dir: 'TX',
      type: 'MRd', status: 'ok', summary: '', phase: 'x',
      packet: { address: 0xfedcba9876543000n, fidelity: 'field-model' },
    }],
  });
  assert.equal(bigDoc.events[0].packet.address, '0xFEDCBA9876543000');
  assert.equal(bigDoc.events[0].fidelity, 'field-model');
});

test('M3/事件 schema：每条事件都有模型时间、保真度与关联字段', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildMemRead(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  for (const ev of sim.events) {
    assert.equal(ev.modelTimeNs, ev.t_ns);
    assert.equal(typeof ev.fidelity, 'string');
    assert.ok('requestId' in ev);
    assert.ok('causeId' in ev);
  }
  const cpl = sim.events.find((e) => e.type === 'CplD');
  assert.equal(cpl.fidelity, 'field-model', 'TLP 事件沿用报文自身的保真度');
});
