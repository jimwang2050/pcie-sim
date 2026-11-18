import { profile } from './model.js';

const byTime = (first, second) => first.atNs - second.atNs;

/**
 * 把一笔 MRd 的首片 RTT 拆到拓扑逐跳：等待 Q、管线延迟 L0、串行化。
 * 数值来自同一次仿真的 service/arrive 事件；L0 与链路容量取自 profile()（与预算同源）。
 */
export function rttLatency(events, breakdown, model) {
  if (!breakdown) return null;
  const mine = events.filter(event => event.txnId === breakdown.id);
  const startAt = breakdown.phases[0].from.atNs;
  const targetEnd = breakdown.phases[1].to.atNs;
  const endAt = breakdown.phases[2].to.atNs;
  const returnLink = breakdown.phases[2].to.node;
  const target = breakdown.phases[1].from.node;
  const hop = (event, role, previousEnd) => {
    const node = event.node ?? event.resource.split(':')[0];
    const settings = profile(model, node);
    const latencyNs = settings.latencyNs;
    const rate = event.packetClass === 'write' || event.packetClass === 'P'
      ? settings.writeGBps ?? settings.bandwidth : settings.bandwidth;
    const serializationNs = event.bytes != null && rate > 0
      ? event.bytes / rate : Math.max(0, event.durationNs - latencyNs);
    return { node, resource: event.resource, role, atNs: event.atNs,
      endNs: event.atNs + event.durationNs, transitNs: event.durationNs, latencyNs, serializationNs,
      turnaroundNs: Math.max(0, event.durationNs - latencyNs - serializationNs),
      waitNs: Math.max(0, event.atNs - (previousEnd ?? event.atNs)) };
  };
  const hops = [];
  let previousEnd = startAt;
  for (const event of mine.filter(item => item.event === 'service' && item.fragment == null).sort(byTime)) {
    if (event.atNs < startAt) continue;
    const role = (event.node ?? event.resource.split(':')[0]) === target ? 'target' : 'request';
    const item = hop(event, role, previousEnd);
    hops.push(item);
    previousEnd = item.endNs;
    if (role === 'target') break;
  }
  for (const event of mine.filter(item => item.event === 'service' && item.fragment === 0).sort(byTime)) {
    if (event.atNs < targetEnd) continue;
    const item = hop(event, 'return', previousEnd);
    hops.push(item);
    previousEnd = item.endNs;
    if (item.node === returnLink) break;
  }
  const taken = new Set(hops.map(item => `${item.node}|${item.atNs}`));
  const burst = breakdown.id.split('/').slice(0, -1).join('/');
  const submitAt = events.find(event => event.event === 'submit')?.atNs ?? null;
  const context = { submitAt, startAt, endAt, firstArrivalAt: endAt, pre: [], post: [] };
  let before = submitAt ?? mine[0]?.atNs ?? startAt;
  for (const event of events.filter(item => item.event === 'service' && item.txnId == null
    && item.atNs <= startAt && (!item.burstId || item.burstId === burst)).sort(byTime)) {
    const item = hop(event, 'pre', before);
    context.pre.push(item);
    before = item.endNs;
  }
  for (const event of mine.filter(item => item.event === 'service' && item.fragment === 0).sort(byTime)) {
    const node = event.node ?? event.resource.split(':')[0];
    if (event.atNs < endAt || taken.has(`${node}|${event.atNs}`)) continue;
    const item = hop(event, 'post', previousEnd);
    context.post.push(item);
    previousEnd = item.endNs;
  }
  const sum = key => hops.reduce((total, item) => total + item[key], 0);
  return { id: breakdown.id, tag: breakdown.tag, firstNs: breakdown.firstNs, lastNs: breakdown.lastNs,
    window: { start: breakdown.phases[0].from.node, end: returnLink, target }, hops, context, tailNs: breakdown.phases[3].ns,
    totals: { waitNs: sum('waitNs'), transitNs: sum('transitNs'), latencyNs: sum('latencyNs'),
      serializationNs: sum('serializationNs'), turnaroundNs: sum('turnaroundNs'),
      rttNs: sum('waitNs') + sum('transitNs') } };
}

export function rttBreakdowns(events, target) {
  const transactions = new Map();
  for (const event of events) {
    if (!event.txnId) continue;
    if (event.event === 'mrd-tx-start') {
      transactions.set(event.txnId, { start: event, arrivals: new Map() });
    }
    const transaction = transactions.get(event.txnId);
    if (!transaction) continue;
    if (event.node === target && event.event === 'service') transaction.memoryStart = event;
    if (event.node === target && event.event === 'arrive') transaction.memoryEnd = event;
    if (event.event === 'cpl-rx-end') transaction.arrivals.set(event.fragment, event);
  }
  return [...transactions.values()].flatMap(({ start, memoryStart, memoryEnd, arrivals }) => {
    if (!memoryStart || !memoryEnd || !memoryEnd.fragments || arrivals.size !== memoryEnd.fragments) return [];
    const replies = [...arrivals.values()];
    const first = replies[0];
    const last = replies.at(-1);
    const phases = [
      { label: 'MRd 去程与目标准入', from: start, to: memoryStart, key: 'request' },
      { label: '目标内存 / BAR 服务', from: memoryStart, to: memoryEnd, key: 'target' },
      { label: '首片 CplD 回程', from: memoryEnd, to: first, key: 'return' },
      { label: '首片至末片间隔', from: first, to: last, key: 'tail' },
    ].map(phase => ({ ...phase, ns: phase.to.atNs - phase.from.atNs }));
    return [{ id: start.txnId, tag: start.tag, phases, firstNs: first.atNs - start.atNs, lastNs: last.atNs - start.atNs }];
  });
}
