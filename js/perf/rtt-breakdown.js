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
