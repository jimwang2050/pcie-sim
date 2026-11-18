import { Scheduler } from '../core/scheduler.js';
import { configFor, topology, flowSpecs, operations, linkCapacity, PERF_SCHEMA } from './model.js';
import { describe, assertFits, creditNeeds } from './budget.js';
import { Resources, claim } from './resources.js';

const quantities = () => ({ read: 0, write: 0 });
const percentiles = values => {
  const sorted = values.slice().sort((first, second) => first - second);
  return Object.fromEntries([50, 95, 99].map(pct => [`p${pct}`, sorted[Math.ceil(sorted.length * pct / 100) - 1] ?? null]));
};

export function simulate(flows, input = {}, options = {}) {
  const model = configFor(input);
  if (model.gen === 6) throw new RangeError('Gen6 is available in budget mode only');
  const { maxEvents = 2_000_000, traceOps = 1, traceLimit = 12000, startNs = 0, endNs = Infinity } = options;
  for (const [name, value] of Object.entries({ maxEvents, traceOps, traceLimit })) {
    if (!Number.isSafeInteger(value) || value < (name === 'maxEvents' ? 1 : 0)) throw new RangeError(name);
  }
  if (!Number.isFinite(startNs) || startNs < 0 || !(endNs > startNs)) throw new RangeError('measurement window');
  const clock = new Scheduler();
  const resources = new Resources(clock);
  const trace = [];
  const allocatedTags = new Map();
  let traceDropped = 0;
  let lastDone = 0;
  let lastRetired = 0;
  let firstIssue = Infinity;
  let events = 0;
  let pending = 0;
  const states = flowSpecs(flows).map(flow => ({
    flow, path: topology(flow.scenario, model), submitted: quantities(), issued: quantities(),
    accepted: quantities(), done: quantities(), measured: quantities(), measuredOps: quantities(),
    issuedOps: quantities(), sampledOps: quantities(), doneOps: quantities(), tagCount: 0,
    tagTotal: 0, first: [], latency: { read: [], write: [] }, acceptedLatency: [], localAcceptCount: 0,
    rttFirst: [], rttLast: [], tagHolds: [], rttStarts: 0,
  }));
  const inside = time => time >= startNs && time < endNs;
  const log = (op, scope) => (event, resource, detail = {}) => {
    if (op.seq >= traceOps) return;
    if (trace.length >= traceLimit) { traceDropped++; return; }
    trace.push({ atNs: clock.time, opId: op.id, kind: op.kind, ...scope, event, resource, ...detail });
  };
  function runStage(item, observe, next, credit, ingressRelease = () => {}) {
    const needs = [claim(item.id), ...(credit ? [credit.header, credit.data] : [])];
    resources.acquire(needs, release => {
      ingressRelease();
      const pool = resources.pool(item.id);
      const turnaround = pool.lastKind && pool.lastKind !== item.kind ? item.turnaroundNs : 0;
      pool.lastKind = item.kind;
      pool.transfers++;
      pool.bytes += item.bytes;
      const operation = { node: item.node, packetClass: item.kind, bytes: item.bytes };
      observe('service', item.id, { ...operation,
        holdNs: item.holdNs + turnaround, durationNs: item.totalNs + turnaround, bytes: item.bytes });
      if (item.node.includes('>')) {
        const wireStart = clock.time;
        const wireEnd = wireStart + item.holdNs;
        pool.wire = { wireStart, wireEnd, bytes: item.bytes };
        clock.after(item.holdNs + turnaround, () => {
          const measured = Math.max(0, Math.min(endNs, wireEnd) - Math.max(startNs, wireStart));
          pool.measuredBytes = (pool.measuredBytes ?? 0) + item.bytes * measured / item.holdNs;
          pool.wire = null;
          release(item.id);
        });
      } else clock.after(item.holdNs + turnaround, () => release(item.id));
      clock.after(item.totalNs + turnaround, () => {
        observe('arrive', item.id, operation);
        const returnCredit = credit ? () => clock.after(model.creditReturnNs, () => {
          release(credit.header.id);
          if (credit.data.amount) release(credit.data.id);
        }) : undefined;
        next(returnCredit);
      });
    }, observe);
  }
  function chain(items, observe, next, credits = [], index = 0, ingressRelease) {
    if (index === items.length) { ingressRelease?.(); next(); return; }
    const item = items[index];
    runStage(item, observe, returnCredit => chain(items, observe, next, credits, index + 1, returnCredit),
      credits.find(credit => credit.link === item.node), ingressRelease);
  }
  function launch(state, op, plan) {
    const { flow, path } = state;
    const read = op.kind === 'read';
    const requestLink = path.route.find(id => id.includes('>'));
    const returnLink = path.returnRoute.findLast(id => id.includes('>'));
    const requester = path.requester;
    const cpu = path.source.endsWith('.CPU');
    const observe = log(op, { flowId: flow.id });
    const issue = cpu ? [claim(`${requester}:issue`)] :
      [claim(`${requester}:dma-ops`, model.dmaOps), claim(`${requester}:dma-bytes`, model.dmaBytes, op.bytes)];
    const ordering = `${flow.id}:visible-order`;
    const ordered = flow.order === 'visible-serial';
    state.issued[op.kind] += op.bytes;
    state.issuedOps[op.kind]++;
    firstIssue = Math.min(firstIssue, clock.time);
    if (inside(op.at)) state.sampledOps[op.kind]++;
    pending++;
    observe('submit', path.source, { bytes: op.bytes, address: op.address });
    resources.acquire(ordered ? [...issue, claim(ordering)] : issue, releaseIssue => {
      let released = false;
      const releaseSource = () => {
        if (released) return;
        released = true;
        for (const need of issue) releaseIssue(need.id);
      };
      let burstLeft = plan.bursts.length;
      let responseLeft = burstLeft;
      let first = false;
      let visibleAt;
      const finish = () => {
        if (burstLeft || responseLeft) return;
        const at = read ? clock.time : visibleAt;
        observe('done', path.target, { timeNs: at });
        pending--;
        state.done[op.kind] += op.bytes;
        state.doneOps[op.kind]++;
        lastDone = Math.max(lastDone, at);
        lastRetired = Math.max(lastRetired, clock.time);
        if (inside(at)) { state.measured[op.kind] += op.bytes; state.measuredOps[op.kind]++; }
        if (inside(op.at)) state.latency[op.kind].push(at - op.at);
        releaseSource();
        if (ordered) releaseIssue(ordering);
      };
      const visible = () => {
        burstLeft--;
        if (!burstLeft) {
          visibleAt = clock.time;
          if (!read) observe('target-visible', path.target);
        }
        finish();
      };
      const responded = () => {
        responseLeft--;
        if (!responseLeft && !read) {
          observe('local-accepted', path.bridge);
          state.accepted.write += op.bytes;
          state.localAcceptCount++;
          if (inside(op.at)) state.acceptedLatency.push(clock.time - op.at);
          if (cpu) releaseSource();
        }
        finish();
      };
      chain([plan.source, ...plan.before], observe, () => {
        plan.bursts.forEach((burst, burstIndex) => {
          const burstId = `${op.id}/${burstIndex}`;
          const burstLog = log(op, { flowId: flow.id, burstId });
          const axi = claim(`${requester}:axi-${op.kind}`, read ? model.axiRead : model.axiWrite);
          resources.acquire([axi], releaseAxi => runStage(burst.launch, burstLog, () => {
            let localLeft = burst.packets.length;
            let targetLeft = localLeft;
            const local = () => {
              if (--localLeft) return;
              runStage(burst.response, burstLog, () => {
                releaseAxi(axi.id);
                if (!read) { responded(); return; }
                if (--responseLeft) { visible(); return; }
                chain(plan.after, observe, visible);
              });
            };
            burst.packets.forEach((part, packetIndex) => {
              const txnId = `${burstId}/${packetIndex}`;
              let tag;
              let wireStart, firstReturn;
              let wireRepliesLeft = part.replies.length;
              const record = fragment => (event, resource, detail) => {
                const observePacket = log(op, { flowId: flow.id, burstId, txnId, requester, tag, fragment });
                observePacket(event, resource, detail);
                if (read && event === 'service' && resource === requestLink) {
                  wireStart = clock.time;
                  if (inside(wireStart)) state.rttStarts++;
                  observePacket('mrd-tx-start', resource, detail);
                }
                if (fragment !== undefined && event === 'arrive' && resource === returnLink) {
                  if (firstReturn === undefined) {
                    firstReturn = clock.time;
                    if (inside(wireStart)) state.rttFirst.push(firstReturn - wireStart);
                  }
                  if (!--wireRepliesLeft && inside(wireStart)) state.rttLast.push(clock.time - wireStart);
                  observePacket('cpl-rx-end', resource, detail);
                }
              };
              const packetLog = record();
              const tracker = read ? [claim(`${requester}:tags`, model.tags),
                claim(`${requester}:completion`, model.completionBytes, part.bytes)] :
                [claim(`${requester}:write-buffer`, model.writeBuffers)];
              resources.acquire(tracker, releaseTracker => {
                const tagAt = clock.time;
                const tags = allocatedTags.get(requester) ?? new Set();
                if (read) {
                  tag = 0;
                  while (tags.has(tag)) tag++;
                  tags.add(tag);
                  allocatedTags.set(requester, tags);
                  packetLog('tag-allocated', requester);
                }
                const releasePacket = () => {
                  if (read) tags.delete(tag);
                  tracker.forEach(need => releaseTracker(need.id));
                };
                const target = () => {
                  const slot = claim(`${path.target}:queue`, model.targetQueue);
                  const targetLog = (event, resource, detail) => packetLog(event, resource,
                    event === 'arrive' ? { ...detail, fragments: part.replies.length } : detail);
                  resources.acquire([slot], releaseSlot => runStage(part.target, targetLog, () => {
                    releaseSlot(slot.id);
                    if (!read) {
                      releasePacket();
                      if (!--targetLeft) visible();
                      return;
                    }
                    let left = part.replies.length;
                    for (const [fragment, reply] of part.replies.entries()) {
                      const replyLog = record(fragment);
                      chain(reply.stages, replyLog, () => {
                        replyLog('completion-arrived', path.requester, { bytes: reply.payload });
                        if (!first) {
                          first = true;
                          if (inside(op.at)) state.first.push(clock.time - op.at);
                        }
                        if (--left) return;
                        releasePacket();
                        state.tagCount++;
                        state.tagTotal += clock.time - tagAt;
                        if (inside(tagAt)) state.tagHolds.push(clock.time - tagAt);
                        local();
                      }, creditNeeds(model, path.returnRoute, 'Cpl', reply.payload));
                    }
                  }), packetLog);
                };
                const credits = creditNeeds(model, path.route, read ? 'NP' : 'P', read ? 0 : part.bytes);
                runStage(part.request[0], packetLog, () => {
                  if (!read) local();
                  chain(part.request, packetLog, target, credits, 1);
                });
              }, packetLog);
            });
          }), burstLog);
        });
      });
    }, observe);
  }
  for (const state of states) {
    for (const op of operations(state.flow)) {
      assertFits(model, state.path, op, describe(model, state.path, op));
      state.submitted[op.kind] += op.bytes;
    }
    const iterator = operations(state.flow);
    const schedule = () => {
      const { value: op, done } = iterator.next();
      if (!done) clock.at(op.at, () => {
        launch(state, op, describe(model, state.path, op));
        schedule();
      });
    };
    schedule();
  }
  while (clock.pending && events < maxEvents) {
    clock.step();
    events++;
  }
  const stopReason = clock.pending ? 'event-limit' : pending || resources.waiters.size ? 'no-progress' : 'complete';
  const drainedNs = clock.time;
  const batchNs = Math.max(0, (stopReason === 'complete' ? lastRetired : drainedNs) - (Number.isFinite(firstIssue) ? firstIssue : 0));
  const measurementEnd = stopReason === 'complete' && Number.isFinite(endNs) ? endNs :
    Math.min(endNs, stopReason === 'complete' ? lastDone : drainedNs);
  const sampleNs = Math.max(0, measurementEnd - startNs);
  const resultFlows = states.map(state => ({
    id: state.flow.id, scenario: state.flow.scenario, path: state.path, submitted: state.submitted,
    issued: state.issued, completed: state.done, completedOps: state.doneOps, accepted: state.accepted, measured: state.measured,
    injectedReadPct: 100 * state.issued.read / (state.issued.read + state.issued.write || 1),
    completedReadPct: 100 * state.done.read / (state.done.read + state.done.write || 1),
    readGBps: sampleNs ? state.measured.read / sampleNs : 0,
    writeGBps: sampleNs ? state.measured.write / sampleNs : 0,
    readIOPS: sampleNs ? state.measuredOps.read * 1e9 / sampleNs : 0,
    writeIOPS: sampleNs ? state.measuredOps.write * 1e9 / sampleNs : 0,
    readNs: percentiles(state.latency.read), writeVisibleNs: percentiles(state.latency.write),
    writeAcceptedNs: percentiles(state.acceptedLatency), firstCompletionNs: percentiles(state.first),
    readRtt: { firstNs: percentiles(state.rttFirst), lastNs: percentiles(state.rttLast),
      firstSamples: state.rttFirst.length, lastSamples: state.rttLast.length,
      incomplete: state.rttStarts - state.rttLast.length },
    tagHoldNs: percentiles(state.tagHolds),
    meanTagHoldNs: state.tagCount ? state.tagTotal / state.tagCount : null,
    tagRequests: state.tagCount, sampleCounts: {
      read: state.latency.read.length, write: state.latency.write.length,
      incompleteRead: state.sampledOps.read - state.latency.read.length,
      incompleteWrite: state.sampledOps.write - state.latency.write.length,
    },
  }));
  const totalBytes = resultFlows.reduce((sum, flow) => sum + flow.completed.read + flow.completed.write, 0);
  const summary = resources.report(drainedNs).map(({ wire, ...pool }) => {
    if (!pool.id.includes('>') || pool.id.includes(':')) return pool;
    const activeNs = wire ? Math.max(0, Math.min(measurementEnd, wire.wireEnd) - Math.max(startNs, wire.wireStart)) : 0;
    const measuredBytes = (pool.measuredBytes ?? 0) + (wire ? activeNs * wire.bytes / (wire.wireEnd - wire.wireStart) : 0);
    const measuredGBps = sampleNs ? measuredBytes / sampleNs : 0;
    return { ...pool, measuredBytes, measuredGBps, measuredUtilization: measuredGBps / linkCapacity(model).budgetGBps };
  });
  return { schema: PERF_SCHEMA, mode: 'simulate', model, link: linkCapacity(model), configs: states.map(state => state.flow),
    stopReason, pending, events, batchNs, drainedNs, sampleNs,
    window: { startNs, endNs: Number.isFinite(endNs) ? endNs : null, effectiveEndNs: measurementEnd },
    throughput: { readGBps: resultFlows.reduce((sum, flow) => sum + flow.readGBps, 0),
      writeGBps: resultFlows.reduce((sum, flow) => sum + flow.writeGBps, 0) },
    batchGBps: batchNs ? totalBytes / batchNs : 0, flows: resultFlows,
    resources: summary, trace, traceDropped };
}
