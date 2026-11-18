import { configFor, topology, flowSpecs, operations, profile, split, completions, packetBytes, linkCapacity, PERF_SCHEMA } from './model.js';
import { FlowControl } from '../core/fc.js';

export function stage(model, id, bytes, kind, direction = '') {
  const node = profile(model, id);
  const rate = kind === 'write' || kind === 'P' ? node.writeGBps ?? node.bandwidth : node.bandwidth;
  const directional = id.includes('>') || id.endsWith('.PHY') || id.endsWith('.AXI');
  const serviceNs = bytes / rate;
  return { id: directional && direction && !id.includes('>') ? `${id}:${direction}` : id,
    node: id, bytes, kind, holdNs: Math.max(node.iiNs, serviceNs), totalNs: node.latencyNs + serviceNs,
    turnaroundNs: node.turnaroundNs ?? 0 };
}

export function packetStages(model, route, type, payload) {
  return route.map((id, index) => stage(model, id, packetBytes(model, type, payload), type,
    id.endsWith('.AXI') ? (type === 'Cpl' ? 'response' : 'request') :
      route[index + 1]?.includes('>') ? 'tx' : 'rx'));
}

export function creditNeeds(model, route, type, payload) {
  return route.filter(id => id.includes('>')).map(id => ({
    link: id, header: { id: `${id}:${type}:header`, capacity: model.creditHeaders, amount: 1 },
    data: { id: `${id}:${type}:data`, capacity: model.creditData, amount: FlowControl.dataCredits(payload) },
  }));
}

export function describe(model, path, operation) {
  const { kind, bytes, address } = operation;
  const read = kind === 'read';
  const local = path.localCopy.map(id => stage(model, id, bytes, read ? 'write' : 'read'));
  return {
    source: stage(model, path.source, 0, kind),
    before: read ? [] : local, after: read ? local : [],
    bursts: split(address, bytes, model.axiBurstBytes).map(burst => ({
      launch: stage(model, path.bridge, read ? 0 : burst.bytes, kind, read ? 'AR' : 'W'),
      response: stage(model, path.bridge, read ? burst.bytes : 0, kind, read ? 'R' : 'B'),
      packets: split(burst.address, burst.bytes, read ? model.mrrs : model.mps).map(part => ({
        ...part, request: packetStages(model, path.route, read ? 'NP' : 'P', read ? 0 : part.bytes),
        target: stage(model, path.target, part.bytes, kind),
        replies: read ? completions(part, model).map(payload => ({
          payload, stages: packetStages(model, path.returnRoute, 'Cpl', payload),
        })) : [],
      })),
    })),
  };
}

export function assertFits(model, path, op, description) {
  if (path.source.endsWith('.DMA') && op.bytes > model.dmaBytes) throw new RangeError('Operation exceeds DMA byte window');
  for (const burst of description.bursts) {
    for (const packet of burst.packets) {
      if (op.kind === 'read' && packet.bytes > model.completionBytes) throw new RangeError('MRd exceeds Completion buffer');
      const payloads = op.kind === 'read' ? packet.replies.map(reply => reply.payload) : [packet.bytes];
      if (payloads.some(payload => FlowControl.dataCredits(payload) > model.creditData)) {
        throw new RangeError('Packet exceeds per-class data Credit capacity');
      }
    }
  }
}

const time = stages => stages.reduce((sum, item) => sum + item.totalNs, 0);

export function analyze(flows, input = {}) {
  const model = configFor(input);
  const specs = flowSpecs(flows);
  const resources = new Map();
  const wireCosts = new Map();
  const add = (id, ns, capacity = 1) => {
    const resource = resources.get(id) ?? { id, demand: 0, capacity };
    resource.demand += ns;
    resources.set(id, resource);
  };
  const service = item => add(item.id, item.holdNs);
  function packetCost(stages, type, payload) {
    stages.forEach(service);
    for (const credit of creditNeeds(model, stages.map(item => item.node), type, payload)) {
      const link = stages.find(item => item.node === credit.link);
      const wire = wireCosts.get(credit.link) ?? { requestBytes: 0, writeBytes: 0, completionBytes: 0 };
      const field = { NP: 'requestBytes', P: 'writeBytes', Cpl: 'completionBytes' }[type];
      wire[field] += link.bytes;
      wireCosts.set(credit.link, wire);
      const duration = link.totalNs + model.creditReturnNs;
      for (const pool of [credit.header, credit.data]) add(pool.id, duration * pool.amount, pool.capacity);
    }
  }
  const perFlow = specs.map(flow => {
    const path = topology(flow.scenario, model);
    let tagNs = 0;
    let tagRequests = 0;
    const bytes = { read: 0, write: 0 };
    for (const op of operations(flow)) {
      const plan = describe(model, path, op);
      assertFits(model, path, op, plan);
      const read = op.kind === 'read';
      bytes[op.kind] += op.bytes;
      [plan.source, ...plan.before, ...plan.after].forEach(service);
      let longestBurst = 0;
      let longestResponse = 0;
      for (const burst of plan.bursts) {
        [burst.launch, burst.response].forEach(service);
        let longestAccept = 0;
        let longestVisible = 0;
        for (const part of burst.packets) {
          packetCost(part.request, read ? 'NP' : 'P', read ? 0 : part.bytes);
          service(part.target);
          for (const reply of part.replies) packetCost(reply.stages, 'Cpl', reply.payload);
          const request = time(part.request);
          const visible = request + part.target.totalNs;
          if (read) {
            const hold = visible + Math.max(...part.replies.map(reply => time(reply.stages)));
            add(`${path.requester}:tags`, hold, model.tags);
            add(`${path.requester}:completion`, hold * part.bytes, model.completionBytes);
            tagNs += hold;
            tagRequests++;
            longestAccept = Math.max(longestAccept, hold);
          } else {
            const accept = time(part.request.slice(0, 1));
            add(`${path.requester}:write-buffer`, visible, model.writeBuffers);
            longestAccept = Math.max(longestAccept, accept);
          }
          add(`${path.target}:queue`, part.target.totalNs, model.targetQueue);
          longestVisible = Math.max(longestVisible, visible);
        }
        const duration = burst.launch.totalNs + longestAccept + burst.response.totalNs;
        add(`${path.requester}:axi-${op.kind}`, duration, read ? model.axiRead : model.axiWrite);
        longestResponse = Math.max(longestResponse, duration);
        longestBurst = Math.max(longestBurst, duration, burst.launch.totalNs + longestVisible);
      }
      const opHold = plan.source.totalNs + time(plan.before) + longestBurst + time(plan.after);
      if (flow.order === 'visible-serial') add(`${flow.id}:visible-order`, opHold);
      if (path.source.endsWith('.CPU')) add(`${path.requester}:issue`, plan.source.totalNs + longestResponse, 1);
      else {
        add(`${path.requester}:dma-ops`, opHold, model.dmaOps);
        add(`${path.requester}:dma-bytes`, opHold * op.bytes, model.dmaBytes);
      }
    }
    return { id: flow.id, scenario: flow.scenario, bytes, path, tagRequests,
      unloadedTagLowerBoundNs: tagRequests ? tagNs / tagRequests : null };
  });
  const usefulBytes = perFlow.reduce((sum, flow) => sum + flow.bytes.read + flow.bytes.write, 0);
  const bounds = [...resources.values()].filter(item => item.demand > 0)
    .map(item => ({ ...item, maxUsefulGBps: usefulBytes * item.capacity / item.demand }))
    .sort((first, second) => first.maxUsefulGBps - second.maxUsefulGBps);
  const link = linkCapacity(model);
  const rcNode = profile(model, 'rc.AXI');
  const idealDirections = [...wireCosts].map(([id, wire]) => {
    const wireBytes = wire.requestBytes + wire.writeBytes + wire.completionBytes;
    const serializationNs = wireBytes / link.budgetGBps;
    return { id, ...wire, wireBytes, capacityGBps: link.budgetGBps, serializationNs,
      maxUsefulGBps: usefulBytes / serializationNs };
  }).sort((first, second) => first.maxUsefulGBps - second.maxUsefulGBps);
  const ideal = idealDirections[0];
  return { schema: PERF_SCHEMA, mode: 'budget', model, configs: specs, link, usefulBytes, upperGBps: bounds[0]?.maxUsefulGBps,
    idealGBps: ideal?.maxUsefulGBps, idealConstraint: ideal?.id, idealDirections,
    rcBridge: {
      widthBits: rcNode.widthBits,
      clockGHz: rcNode.clockGHz,
      interfacePeakGBps: rcNode.interfacePeakGBps,
      effectiveGBps: rcNode.bandwidth,
      note: '物理 AXI 峰值 = widthBits/8 × clockGHz；有效上限是桥接器策略，必须 ≤ 物理峰值',
    },
    bounds, flows: perFlow, basis: 'Fixed submitted byte mix; optimistic end-to-end batch ceiling; no queuing or turnaround' };
}

export function throughputAttainment(budget, simulation) {
  if (simulation?.stopReason !== 'complete' || !(simulation.batchNs > 0)) return null;
  const ratio = reference => reference > 0 ? 100 * simulation.batchGBps / reference : null;
  return { batchGBps: simulation.batchGBps, idealPct: ratio(budget.idealGBps), upperPct: ratio(budget.upperGBps) };
}
