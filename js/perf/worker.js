import { analyze, throughputAttainment } from './budget.js';
import { simulate } from './simulate.js';

self.onmessage = ({ data: { flows, model } }) => {
  try {
    const budget = analyze(flows, model);
    const simulation = model.gen === 6 ? null : simulate(flows, model, { traceOps: 4, maxEvents: 500000 });
    self.postMessage({ budget, simulation, attainment: throughputAttainment(budget, simulation) });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
