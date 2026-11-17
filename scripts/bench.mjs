/**
 * 模型吞吐基准（不涉及 DOM 渲染）。
 * 运行：node scripts/bench.mjs
 *
 * 只测核心事件循环，不代表浏览器渲染性能；用于发现数量级问题。
 */
import { Sim } from '../js/core/sim.js';

function bench(label, fn, runs) {
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const pick = (q) => times[Math.min(times.length - 1, Math.max(0, Math.ceil(times.length * q) - 1))];
  return { label, runs, p50Ms: +pick(0.5).toFixed(1), p95Ms: +pick(0.95).toFixed(1) };
}

const emitOnly = bench('emit 10k（无调度、无历史）', () => {
  const sim = new Sim();
  sim.reset({ gen: 5, width: 8 });
  for (let i = 0; i < 10000; i += 1) {
    sim.emit({ layer: 'TL', row: 'RC.TL', dir: 'TX', type: 'SYNTH', summary: 'x' });
  }
}, 5);

const stepped = bench('step+emit 2k（含 200 步历史快照）', () => {
  const sim = new Sim();
  sim.reset({ gen: 5, width: 8 });
  for (let i = 0; i < 2000; i += 1) {
    sim.at(i * 10, () => sim.emit({ layer: 'TL', row: 'RC.TL', dir: 'TX', type: 'SYNTH', summary: 'x' }));
  }
  sim.runToEnd(2100);
}, 3);

const emitPerEventUs = (emitOnly.p50Ms * 1000) / 10000;
const stepPerEventUs = (stepped.p50Ms * 1000) / 2000;

console.log(JSON.stringify({
  node: process.version,
  note: '模型时间基准：仅核心事件循环，不含界面渲染；单次运行结果随机器变化',
  emitOnly,
  stepped,
  emitPerEventUs: +emitPerEventUs.toFixed(2),
  stepPerEventUs: +stepPerEventUs.toFixed(2),
}, null, 2));
