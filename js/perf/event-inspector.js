const names = {
  submit: '业务提交', enqueue: '进入队列', block: '资源阻塞', grant: '获得资源',
  service: '开始服务', arrive: '服务结束 / 抵达', release: '释放资源',
  'tag-allocated': '分配 Tag', 'mrd-tx-start': 'MRd 开始发送 · RTT 起点',
  'cpl-rx-end': 'CplD 抵达 · RTT 测量点', 'completion-arrived': '请求方收到 Completion',
  'local-accepted': '写入本地接受', 'target-visible': '写入目标可见', done: '业务完成',
};
const types = { NP: 'MRd', P: 'MWr', Cpl: 'CplD', read: '本地读', write: '本地写' };

export function eventName(event) {
  if (/>[^:]+:(P|NP|Cpl):(header|data)$/.test(event.resource) && event.event === 'release') {
    return 'Credit 回补（模型）';
  }
  return names[event.event] ?? event.event;
}

export function createInspector(get, format, playback) {
  const dialog = get('event-inspector');
  const picker = get('inspect-step');
  const previous = get('inspect-prev');
  const next = get('inspect-next');
  let events = [], origin = 0, txTimes = new Map();

  function render(index, seek = false) {
    const event = events[index];
    if (!event) return;
    picker.selectedIndex = index;
    previous.disabled = index === 0;
    next.disabled = index === events.length - 1;
    if (seek) playback.seek(event.atNs);
    const head = document.createElement('h3');
    head.textContent = `${index + 1} / ${events.length} · ${eventName(event)}`;
    const list = document.createElement('dl');
    const field = (label, value) => {
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = label;
      detail.textContent = value;
      list.append(term, detail);
    };
    field('仿真时间', `${format(event.atNs)} ns（样本 +${format(event.atNs - origin)} ns）`);
    field('资源', event.resource);
    field('操作', `${event.opId} · ${event.kind === 'read' ? '读' : '写'}`);
    if (event.burstId) field('AXI burst', event.burstId);
    if (event.txnId) field('事务', event.txnId);
    if (event.tag != null) field('Requester / Tag', `${event.requester} / ${event.tag}`);
    if (event.fragment != null) field('Completion 片段', event.fragment + 1);
    if (event.address != null) field('地址', `0x${event.address.toString(16)}`);
    if (event.packetClass) field('类型', types[event.packetClass] ?? event.packetClass);
    if (event.bytes != null) field('数据量', `${format(event.bytes)} B${event.packetClass && event.node?.includes('>') ? '（模型线字节）' : ''}`);
    if (event.waitNs != null) field('准入等待 Q', `${format(event.waitNs)} ns`);
    if (event.durationNs != null) field('服务 / 资源忙碌', `${format(event.durationNs)} / ${format(event.holdNs)} ns`);
    if (event.heldNs != null) field('持有', `${format(event.heldNs)} ns`);
    if (event.capacity != null) field('本次额度 / 事件时占用', `${event.amount} / ${event.used}（容量 ${event.capacity}）`);
    const start = txTimes.get(event.txnId);
    if (event.event === 'cpl-rx-end' && start != null) field('该片 RTT', `${format(event.atNs - start)} ns`);
    get('inspect-event').replaceChildren(head, list);
  }

  picker.addEventListener('change', () => render(picker.selectedIndex, true));
  previous.addEventListener('click', () => render(picker.selectedIndex - 1, true));
  next.addEventListener('click', () => render(picker.selectedIndex + 1, true));
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });

  return (label, matches, metrics, simulation) => {
    playback.pause();
    const sample = playback.snapshot();
    origin = sample.origin;
    const trace = (simulation?.trace ?? []).filter(event => sample.sample === 'all' || event.opId === sample.sample);
    txTimes = new Map(trace.filter(event => event.event === 'mrd-tx-start').map(event => [event.txnId, event.atNs]));
    events = trace.filter(event => matches(event.resource) || (event.node && matches(event.node)));
    get('inspect-title').textContent = label;
    get('inspect-metrics').textContent = metrics;
    get('inspect-scope').textContent = simulation ?
      `样本：${sample.sample === 'all' ? '多笔叠加' : sample.sample} · 当前播放 +${format(sample.atNs - origin)} ns${simulation.traceDropped ? ' · Trace 已截断' : ''}` :
      '当前仅有解析预算，无事件样本。';
    get('inspect-controls').hidden = !events.length;
    picker.replaceChildren(...events.map((event, index) =>
      new Option(`${index + 1}. +${format(event.atNs - origin)} ns · ${eventName(event)}`, index)));
    get('inspect-event').textContent = simulation ? '该节点在所选样本中没有事件。可关闭浮窗后切换播放样本。' : '';
    if (events.length) {
      const current = events.findLastIndex(event => event.atNs <= sample.atNs);
      render(Math.max(0, current));
    }
    if (!dialog.open) dialog.showModal();
  };
}
