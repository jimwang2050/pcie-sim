import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { analyze, throughputAttainment } from '../js/perf/budget.js';
import { simulate } from '../js/perf/simulate.js';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    scenario: { type: 'string' }, 'read-pct': { type: 'string' }, count: { type: 'string' },
    gen: { type: 'string' }, lanes: { type: 'string' }, config: { type: 'string' },
    trace: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) {
    console.log('node scripts/perf.mjs budget|simulate|matrix [--scenario ep-ddr|cpu-bar|host-dma|p2p|p2p-reverse] [--read-pct 0..100] [--count N] [--gen 4|5|6] [--lanes N] [--config input.json] [--trace N] [--json]');
  } else {
    const [mode] = positionals;
    if (positionals.length !== 1 || !['budget', 'simulate', 'matrix'].includes(mode)) throw new RangeError('Expected budget, simulate or matrix');
    const input = values.config ? JSON.parse(readFileSync(values.config, 'utf8')) : {};
    const model = { ...input.model };
    const options = { ...input.options };
    const flow = {};
    if (values.scenario !== undefined) flow.scenario = values.scenario;
    if (values['read-pct'] !== undefined) flow.readPct = Number(values['read-pct']);
    if (values.count !== undefined) flow.count = Number(values.count);
    for (const key of ['gen', 'lanes']) if (values[key] !== undefined) model[key] = Number(values[key]);
    if (values.trace !== undefined) options.traceOps = Number(values.trace);
    const flows = (input.flows ?? [{}]).map(item => ({ ...item, ...flow }));
    const run = specs => {
      const budget = analyze(specs, model);
      if (mode === 'budget') return budget;
      const simulation = simulate(specs, model, options);
      return { budget, ...simulation, attainment: throughputAttainment(budget, simulation) };
    };
    const result = mode === 'matrix' ?
      (values.scenario ? [values.scenario] : ['ep-ddr', 'cpu-bar', 'host-dma', 'p2p']).flatMap(scenario =>
        [100, 75, 50, 25, 0].map(readPct => run([{ ...flow, scenario, readPct }]))) : run(flows);
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      const runs = Array.isArray(result) ? result : [result];
      const rounded = number => number == null ? null : Number(number.toFixed(4));
      console.table(runs.flatMap(run => run.flows.map((item, index) => ({
        scenario: item.scenario, readPct: run.configs[index].readPct, state: run.stopReason ?? 'budget',
        batchGBps: rounded(run.batchGBps), readGBps: rounded(item.readGBps),
        writeGBps: rounded(item.writeGBps), readP99ns: rounded(item.readNs?.p99),
        writeP99ns: rounded(item.writeVisibleNs?.p99), upperGBps: rounded((run.budget ?? run).upperGBps),
        idealGBps: rounded((run.budget ?? run).idealGBps), idealPct: rounded(run.attainment?.idealPct),
        upperPct: rounded(run.attainment?.upperPct),
        rttLastP99ns: rounded(item.readRtt?.lastNs.p99),
        upperConstraint: (run.budget ?? run).bounds[0]?.id,
      }))));
      if (mode === 'simulate') {
        const stalls = result.resources.filter(resource => resource.blocked)
          .sort((first, second) => second.waitNs - first.waitNs).slice(0, 10);
        console.table(stalls.map(({ id, peak, capacity, blocked, waitNs }) => ({ id, peak, capacity, blocked, waitNs: rounded(waitNs) })));
      }
    }
    if ([result].flat().some(run => run.stopReason && run.stopReason !== 'complete')) process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
