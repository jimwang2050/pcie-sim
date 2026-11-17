import test from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../js/core/sim.js';
import { SCENARIOS, clampScenarioConfig, resolveScenarioConfig, WIDTHS } from '../js/scenarios/registry.js';

const names = {
  link_training: 'buildLinkTraining', enumeration: 'buildEnumeration', ltssm_pm: 'buildLtssmPm',
  phy_link: 'buildPhyLink', flit_gen6: 'buildFlitGen6', loopback_bert: 'buildLoopbackBert',
  mem_read: 'buildMemRead', mem_write: 'buildMemWrite', msi_int: 'buildMsiInt',
  aer_error: 'buildAerError', dpc_rpio: 'buildDpcRpio', ats: 'buildAts', pm_dp: 'buildPmDp',
};
const builders = {};
for (const [key, name] of Object.entries(names)) builders[key] = (await import(`../js/scenarios/${key}.js`))[name];
function options(key, input) {
  return key === 'loopback_bert' ? { ...input, mode: 'external', transportMode: input.mode } : input;
}
function state(s) {
  const snap = s.snapshot();
  // Callback identity is an implementation detail: enumeration dynamically
  // schedules closures. Compare every scheduled time/sequence/meta instead.
  snap.queue = snap.queue.map(({ t, seq, meta }) => ({ t, seq, meta }));
  return { snapshot: snap, events: s.events.slice() };
}

for (const key of Object.keys(SCENARIOS)) {
  test(`场景能力矩阵：${key}（6代×5宽度×3模式）`, () => {
    for (const gen of [1, 2, 3, 4, 5, 6]) for (const width of WIDTHS) for (const mode of ['auto', 'nonflit', 'flit']) {
      const input = { gen, width, mode };
      let resolved;
      try { resolved = resolveScenarioConfig(key, input); } catch { /* Rejection checked below. */ }
      const s = new Sim(); s.reset();
      if (!resolved) {
        const before = state(s);
        assert.throws(() => builders[key](s, options(key, input)), RangeError);
        assert.deepEqual(state(s), before, `${key} invalid config mutated state`);
      } else {
        s.reset(input);
        builders[key](s, options(key, input)); s.runToEnd();
        assert.equal(s.pending, 0);
        assert.equal(s.link.gen, gen);
        assert.equal(s.link.width, width);
        assert.equal(s.link.flitMode, resolved.effectiveMode === 'flit');
        assert.ok(s.events.length > 0);
        let last = -Infinity;
        for (const e of s.events) {
          assert.ok(Number.isFinite(e.t_ns) && e.t_ns >= last);
          last = e.t_ns;
        }
        if (resolved.effectiveMode === 'flit') assert.equal(resolved.fidelity, 'schematic');
      }
    }
  });

  test(`逐步回退重放全部保留状态：${key}`, () => {
    const input = { gen: key === 'flit_gen6' ? 6 : 3, width: 8, mode: 'auto' };
    const s = new Sim(); s.reset(input); builders[key](s, options(key, input));
    const expected = new Map([[0, state(s)]]);
    let steps = 0;
    while (s.pending) { s.stepOnce(); expected.set(++steps, state(s)); }
    const end = steps;
    while (s.history.length) {
      assert.ok(s.stepBack());
      assert.deepEqual(state(s), expected.get(--steps), `${key} rewind step ${steps}`);
    }
    while (s.pending) {
      s.stepOnce();
      assert.deepEqual(state(s), expected.get(++steps), `${key} replay step ${steps}`);
    }
    assert.equal(steps, end);
  });
}

test('产品限制与协议能力分开；非法全局输入拒绝', () => {
  assert.equal(resolveScenarioConfig('link_training', { gen: 5, mode: 'flit' }).effectiveMode, 'flit');
  assert.throws(() => resolveScenarioConfig('mem_read', { gen: 5, mode: 'flit' }), /暂不支持/);
  assert.throws(() => resolveScenarioConfig('link_training', { gen: 6, mode: 'nonflit' }), /64 GT\/s/);
  for (const input of [{ gen: 7 }, { width: 3 }, { mode: 'typo' }]) assert.throws(() => resolveScenarioConfig('link_training', input), RangeError);
});

test('切换场景时收敛到最近合法配置，不留下无法播放的组合', () => {
  assert.deepEqual(clampScenarioConfig('mem_read', { gen: 5, width: 8, mode: 'auto' }).changes, []);
  assert.deepEqual(clampScenarioConfig('mem_read', { gen: 6, width: 8, mode: 'auto' }),
    { config: { gen: 5, width: 8, mode: 'auto' }, changes: [{ field: 'gen', from: 6, to: 5 }] });
  assert.deepEqual(clampScenarioConfig('mem_read', { gen: 6, width: 8, mode: 'flit' }).config,
    { gen: 5, width: 8, mode: 'auto' });
  assert.deepEqual(clampScenarioConfig('link_training', { gen: 6, width: 8, mode: 'nonflit' }).config,
    { gen: 6, width: 8, mode: 'auto' });
  assert.deepEqual(clampScenarioConfig('phy_link', { gen: 3, width: 8, mode: 'flit' }).config,
    { gen: 3, width: 8, mode: 'auto' });
  assert.deepEqual(clampScenarioConfig('flit_gen6', { gen: 3, width: 8, mode: 'auto' }).config,
    { gen: 6, width: 8, mode: 'auto' });
  for (const key of Object.keys(SCENARIOS)) for (const gen of [1, 2, 3, 4, 5, 6]) for (const width of WIDTHS) for (const mode of ['auto', 'nonflit', 'flit']) {
    const { config } = clampScenarioConfig(key, { gen, width, mode });
    assert.doesNotThrow(() => resolveScenarioConfig(key, config), `${key} ${gen}x${width} ${mode}`);
  }
});
