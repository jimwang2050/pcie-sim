import { DEFAULTS, profile, rcBridgePreset } from './model.js';
import { drawTopology } from './topology-view.js';
import { createPlayback } from './playback-view.js';
import { createInspector, eventName } from './event-inspector.js';
import { rttBreakdowns } from './rtt-breakdown.js';
import { groupTrace } from './trace-groups.js';

const get = id => document.getElementById(id);
const form = get('controls');
const status = get('status');

// 深色 / 浅色：与教学页共享 pcie-sim-theme
const THEME_KEY = 'pcie-sim-theme';
const themeButton = get('theme-toggle');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === 'light' ? '深色' : '浅色';
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (error) { /* 本地存储不可用时只改当前页面 */ }
}

applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
themeButton.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

const format = value => value == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(value);
let worker;
let result;
let activeBoard;
let breakdowns = [];
function updateTraceView() {
  const staticMode = get('trace-view').value === 'rtt';
  const selected = breakdowns[Number(get('rtt-txn').value)];
  get('rtt-static').hidden = !staticMode;
  get('playback').hidden = staticMode || !result?.simulation?.trace.length;
  get('timeline-card').hidden = staticMode || !result?.simulation;
  if (staticMode) playback.pause();
  activeBoard?.rtt(selected, staticMode);
  if (!staticMode) playback.refresh();
  get('rtt-static-summary').textContent = selected ?
    `首片 RTT ${format(selected.firstNs)} ns；末片 RTT ${format(selected.lastNs)} ns。沿同字母虚线从硬件读到时间尺：A 发出、B 目标开始、C 目标结束、D 首片、E 末片（单片时合并为 D）。` :
    '此操作没有可完整重建的 MRd 往返（纯写、样本不完整，或未收齐 Completion）。';
}
const playback = createPlayback(get, format, id => {
  get('trace-op').value = id;
  timeline(result?.simulation);
});
const inspectEvent = createInspector(get, format, playback);

function element(tag, content, className) {
  const item = document.createElement(tag);
  if (content !== undefined) item.textContent = content;
  if (className) item.className = className;
  return item;
}

function table(id, headers, rows, empty) {
  const host = get(id);
  host.replaceChildren();
  if (!rows.length) { host.append(element('p', empty, 'hint')); return; }
  const wrap = element('div', undefined, 'scroll');
  const grid = element('table');
  const head = grid.createTHead().insertRow();
  for (const label of headers) head.append(element('th', label));
  const body = grid.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) row.insertCell().textContent = value;
  }
  wrap.append(grid);
  host.append(wrap);
}

function bar(label, value, scale, color, left = 0, extra = '') {
  const row = element('div', undefined, extra ? `bar-row ${extra}` : 'bar-row');
  const track = element('span', undefined, 'track');
  const fill = element('span', undefined, `fill ${color}`);
  fill.style.left = `${Math.min(100, left / scale * 100)}%`;
  fill.style.width = `${Math.min(100, value / scale * 100)}%`;
  track.append(fill);
  row.append(element('span', label), track, element('strong', format(value)));
  return row;
}

const labels = {
  'epA>rc': 'EP A → RP', 'rc>epA': 'RP → EP A', 'epA>sw': 'EP A → Switch',
  'sw>epA': 'Switch → EP A', 'epB>sw': 'EP B → Switch', 'sw>epB': 'Switch → EP B',
};
const nodeMatch = (key, id) => key === id || key.startsWith(`${id}:`);

function renderTopology(budget, simulation, attainment) {
  const host = get('topology');
  host.replaceChildren();
  const metrics = get('metric-map');
  metrics.replaceChildren();
  const metric = (title, value, caption) => {
    const card = element('div', undefined, 'metric-card');
    card.append(element('span', title), element('strong', value), element('small', caption));
    metrics.append(card);
  };
  const limit = budget.bounds[0];
  metric('链路理想 · 固定业务配比', `${format(budget.idealGBps)} GB/s`,
    `${labels[budget.idealConstraint] ?? budget.idealConstraint}${attainment ? ` · 达成 ${format(attainment.idealPct)}%` : ''}`);
  if (limit) metric('解析瓶颈 · 固定业务配比', `${format(limit.maxUsefulGBps)} GB/s`, limit.id);
  if (simulation) metric('业务交付 · 同一采样窗',
    `${format(simulation.throughput.readGBps + simulation.throughput.writeGBps)} GB/s`,
    `R ${format(simulation.throughput.readGBps)} / W ${format(simulation.throughput.writeGBps)} GB/s · Δt ${format(simulation.sampleNs)} ns`);
  for (const [index, flow] of budget.flows.entries()) {
    if (!flow.bytes.read) continue;
    const result = simulation?.flows[index]?.readRtt;
    const tx = flow.path.route.find(id => id.includes('>'));
    const rx = flow.path.returnRoute.findLast(id => id.includes('>'));
    metric(`${flow.id} · RTT 首片 / 末片 P50`,
      result ? `${format(result.firstNs.p50)} / ${format(result.lastNs.p50)} ns` : '仅解析预算',
      `t₀ ${labels[tx]} · tCpl ${labels[rx]}`);
  }
  const selectNode = (label, id, inspect) => {
    const aliases = { 'epA.CTL': 'epA', 'epB.CTL': 'epB', 'cpu.AXI': 'cpu', 'hostDMA.AXI': 'hostDMA' };
    const matches = key => nodeMatch(key, id) || (aliases[id] && nodeMatch(key, aliases[id]));
    const entries = simulation?.resources.filter(item => matches(item.id)) ?? [];
    const bounds = budget.bounds.filter(item => matches(item.id));
    const details = entries.map(item => `${item.id}：峰值 ${item.peak}/${item.capacity}，累计等待 ${format(item.waitNs)} ns`);
    const wire = entries.find(item => item.id === id && item.measuredGBps !== undefined);
    const node = profile(budget.model, id);
    details.unshift(id.includes('>') ?
      `每向容量 Cℓ=${format(node.bandwidth)} GB/s；传播 L₀=${format(node.latencyNs)} ns` :
      `L₀=${format(node.latencyNs)} ns；启动间隔=${format(node.iiNs)} ns；服务容量 R/W=${format(node.bandwidth)}/${format(node.writeGBps)} GB/s`);
    if (wire) details.unshift(`线流量 ${format(wire.measuredGBps)} GB/s，占用 ${format(wire.measuredUtilization * 100)}%`);
    if (bounds.length) {
      const bound = bounds[0];
      details.push(`最紧约束 ${bound.id}：K=${format(bound.capacity)}，D=${format(bound.demand)} 资源单位·ns，K×V/D=${format(bound.maxUsefulGBps)} GB/s`);
    }
    const summary = details.join('；');
    get('node-detail').textContent = `${label} · ${summary}`;
    if (inspect) inspectEvent(label, matches, summary, simulation);
  };
  return drawTopology(host, budget, simulation, selectNode, format);
}

function timeline(simulation) {
  const picker = get('trace-op');
  const host = get('timeline');
  host.replaceChildren();
  const events = simulation?.trace.filter(event => event.opId === picker.value) ?? [];
  const submit = events.find(event => event.event === 'submit');
  get('txn-stops').replaceChildren();
  get('txn-focus').textContent = '';
  activeBoard?.mark([], () => {});
  breakdowns = [];
  get('rtt-txn').replaceChildren();
  if (!submit) { get('trace-note').textContent = '此运行没有可用的事件样本。'; return; }
  const origin = submit.atNs;
  const path = simulation.flows.find(flow => flow.id === submit.flowId).path;
  const { target } = path;
  breakdowns = rttBreakdowns(events, target);
  get('rtt-txn').replaceChildren(...breakdowns.map((item, index) =>
    new Option(`${item.id} · Tag ${item.tag} · ${format(item.lastNs)} ns`, index)));
  const keyEvents = new Set(['submit', 'tag-allocated', 'mrd-tx-start', 'target-visible', 'local-accepted', 'done']);
  const selected = events.filter(event => keyEvents.has(event.event) || event.event === 'block' ||
    (event.event === 'service' && (event.node === target || event.node?.includes('>') && event.packetClass === 'P')) ||
    (event.event === 'cpl-rx-end'));
  const first = new Map();
  const last = new Map();
  for (const event of selected) {
    const key = `${event.event}|${event.resource}`;
    if (!first.has(key)) first.set(key, event);
    last.set(key, event);
  }
  const picked = new Set([...first.values(), ...[...last.values()].filter(event => event.event === 'cpl-rx-end')]);
  const stops = selected.filter(event => picked.has(event));
  const txTimes = new Map(events.filter(event => event.event === 'mrd-tx-start').map(event => [event.txnId, event.atNs]));
  const buttons = [];
  const rows = new Map();
  let outlined = [];
  const stopName = event => event.event === 'service' ? (event.node?.includes('>') ? 'MWr 发送' : '目标开始服务') : eventName(event);
  const jump = index => {
    if (get('trace-view').value === 'rtt') {
      get('trace-view').value = 'events';
      updateTraceView();
    }
    const event = stops[index];
    playback.seek(event.atNs);
    buttons.forEach((button, item) => button.setAttribute('aria-pressed', String(item === index)));
    activeBoard?.selectMilestone(index);
    for (const row of outlined) row.classList.remove('trace-selected', 'trace-related');
    outlined = [];
    for (const [entry, row] of rows) {
      if (entry.atNs !== event.atNs || entry.resource !== event.resource ||
        entry.txnId !== event.txnId || entry.burstId !== event.burstId || entry.fragment !== event.fragment) continue;
      row.classList.add(entry === event ? 'trace-selected' : 'trace-related');
      row.closest('details').open = true;
      outlined.push(row);
    }
    get('timeline-card').open = true;
    const match = rows.get(event);
    if (match) host.scrollTop += match.getBoundingClientRect().top - host.getBoundingClientRect().top -
      (host.clientHeight - match.offsetHeight) / 2;
    const start = txTimes.get(event.txnId);
    get('txn-focus').textContent = `#${index + 1} · ${event.resource} · ${stopName(event)} · +${format(event.atNs - origin)} ns` +
      (event.tag != null ? ` · Tag ${event.tag}` : '') +
      (event.event === 'cpl-rx-end' && start != null ? ` · 该片 RTT ${format(event.atNs - start)} ns` : '');
  };
  stops.forEach((event, index) => {
    const name = stopName(event);
    const button = element('button', undefined, 'txn-stop');
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    button.append(element('strong', `${index + 1} · ${name}`),
      element('small', `${event.resource} · +${format(event.atNs - origin)} ns`));
    button.addEventListener('click', () => jump(index));
    buttons.push(button);
    get('txn-stops').append(button);
  });
  activeBoard?.mark(stops, jump);
  playback.refresh();
  get('txn-route-note').textContent = '从提交起计时。点图上编号或下方站点，自动展开并用虚线框标出对应记录。';
  const end = Math.max(1, ...events.map(event => event.atNs - origin));
  get('trace-note').textContent = `按职责分组，组内按仿真时间排序；不同组可能重叠。每行以提交为 0 ns，虚线框标出拓扑所选事件及同刻相关记录。${simulation.traceDropped ? '样本已截断。' : ''}`;
  for (const stage of groupTrace(events, path)) {
    const group = element('details', undefined, 'trace-group');
    group.dataset.phase = stage.id;
    const heading = element('summary');
    const start = stage.events[0].atNs - origin;
    const finish = stage.events.at(-1).atNs - origin;
    const stalls = stage.events.filter(event => event.event === 'block').length;
    heading.append(element('strong', stage.title), element('small',
      `${stage.events.length} 条 · +${format(start)}～${format(finish)} ns${stalls ? ` · ${stalls} 条阻塞` : ''}`));
    group.append(heading, element('p', stage.description, 'hint trace-group-note'));
    host.append(group);
    for (const event of stage.events) {
      const offset = event.atNs - origin;
      const duration = event.durationNs ?? 0;
      const label = `${eventName(event)} · ${event.resource}`;
      const row = bar(label, duration || end * .006, end, event.kind === 'write' ? 'write' : '', offset, 'timeline-row');
      row.lastChild.textContent = duration ? `+${format(offset)}` : format(offset);
      row.title = `${label}：${format(offset)} ns${duration ? `，服务 ${format(duration)} ns` : ''}`;
      rows.set(event, row);
      group.append(row);
    }
  }
  updateTraceView();
}

function render({ budget, simulation, attainment }) {
  const board = renderTopology(budget, simulation, attainment);
  activeBoard = board;
  const ideal = budget.idealDirections[0];
  const unit = budget.model.gen === 6 ? 'TLP 区 B' : '线 B';
  const efficiency = budget.model.gen === 6 ? '236/256' : `128/130 × ${format(budget.model.nfmAvailability)}`;
  const calculation = get('ideal-calculation');
  calculation.replaceChildren(element('p',
    `单向容量 Cℓ = ${{ 4: 16, 5: 32, 6: 64 }[budget.model.gen]} × ${budget.model.lanes} / 8 × ${efficiency} = ${format(budget.link.budgetGBps)} GB/s。`));
  if (budget.rcBridge) {
    calculation.append(element('p',
      `RC Bridge：AXI ${budget.rcBridge.widthBits} bit × ${format(budget.rcBridge.clockGHz)} GHz = ${format(budget.rcBridge.interfacePeakGBps)} GB/s 物理峰值；桥接器有效上限 ${format(budget.rcBridge.effectiveGBps)} GB/s（有效上限必须 ≤ 物理峰值）。`));
  }
  if (ideal) calculation.append(element('p',
    `瓶颈：${labels[ideal.id] ?? ideal.id}。理想吞吐 = ${format(budget.usefulBytes)} 业务 B ÷ (${format(ideal.wireBytes)} ${unit} ÷ ${format(ideal.capacityGBps)} GB/s) ≈ ${format(budget.idealGBps)} GB/s。`));
  table('ideal-directions', ['链路方向', 'MRd B', 'MWr B', 'CplD B', `合计 ${unit}`, '串行化 ns', '可达业务 GB/s'],
    budget.idealDirections.map(item => [labels[item.id] ?? item.id, ...[
      item.requestBytes, item.writeBytes, item.completionBytes, item.wireBytes, item.serializationNs, item.maxUsefulGBps,
    ].map(format)]), '本轮无链路字节。');
  const throughput = get('bandwidth');
  throughput.replaceChildren();
  const scale = Math.max(1e-6, budget.idealGBps, budget.upperGBps, simulation?.batchGBps ?? 0,
    ...(simulation?.flows.flatMap(flow => [flow.readGBps, flow.writeGBps]) ?? []));
  throughput.append(bar('链路理想', budget.idealGBps, scale, 'neutral'), bar('资源上界', budget.upperGBps, scale, 'neutral'));
  if (simulation) {
    throughput.append(bar('整批有效', simulation.batchGBps, scale, 'neutral'));
    for (const flow of simulation.flows) {
      throughput.append(bar(`${flow.id} 读`, flow.readGBps, scale, ''),
        bar(`${flow.id} 写`, flow.writeGBps, scale, 'write'));
    }
  }
  throughput.append(element('p', `首要解析约束：${budget.bounds[0]?.id ?? '—'}`, 'hint'));
  throughput.append(element('p', attainment ?
    `整批达成率：链路理想 ${format(attainment.idealPct)}% · 资源上界 ${format(attainment.upperPct)}%` :
    '达成率需要完整事件仿真；当前无可比整批结果。', 'hint'));
  const stats = simulation?.flows.flatMap(flow => [
    ['PCIe RTT · 首片', flow.readRtt.firstNs], ['PCIe RTT · 末片', flow.readRtt.lastNs],
    ['Tag 持有', flow.tagHoldNs], ['读端到端 · 首片', flow.firstCompletionNs], ['读端到端 · 完成', flow.readNs],
    ['写接受', flow.writeAcceptedNs], ['写可见', flow.writeVisibleNs],
  ].filter(([, values]) => values.p50 != null).map(([name, values]) => [
    `${flow.id} ${name}`, ...[values.p50, values.p95, values.p99].map(format),
  ])) ?? [];
  table('latency', ['完成口径', 'P50', 'P95', 'P99'], stats, '解析模式没有延迟采样。');
  if (simulation) {
    get('latency').append(element('p', 'RTT 从发起端首跳 MRd 开始发送，到 CplD 完整抵达发起端；每笔 MRd 单独计时。', 'hint'));
    throughput.append(element('p', `采样窗 ${format(simulation.sampleNs)} ns；读按可消费字节，写按目标可见字节计。`, 'hint'));
  }
  const wires = simulation?.resources.filter(item => item.id.includes('>') && !item.id.includes(':'));
  const links = wires ? wires.map(item => [labels[item.id] ?? item.id, format(item.measuredGBps),
    `${format(item.measuredUtilization * 100)}%`]) :
    budget.bounds.filter(item => item.id.includes('>') && !item.id.includes(':'))
      .map(item => [labels[item.id] ?? item.id, format(budget.link.budgetGBps), '—']);
  table('links', ['物理方向', wires ? '线流量 GB/s' : '线预算 GB/s', '占用'], links, '没有活动链路。');
  get('resource-title').textContent = simulation ? '资源阻塞 · 累计' : '解析资源约束';
  if (simulation) {
    const blocked = simulation.resources.filter(item => item.waitNs > 0)
      .sort((first, second) => second.waitNs - first.waitNs);
    table('resources', ['资源', '峰值/容量', '等待 ns'], blocked.slice(0, 10).map(item => [
      item.id, `${item.peak}/${item.capacity}`, format(item.waitNs),
    ]), '此负载无资源等待。');
  } else table('resources', ['资源', '最大有效 GB/s'], budget.bounds.slice(0, 10)
    .map(item => [item.id, format(item.maxUsefulGBps)]), '没有约束。');
  const picker = get('trace-op');
  picker.replaceChildren();
  for (const event of simulation?.trace.filter(item => item.event === 'submit') ?? []) {
    const option = element('option', `${event.opId} · ${event.kind === 'read' ? '读' : '写'} ${event.bytes} B`);
    option.value = event.opId;
    picker.append(option);
  }
  get('txn-route').hidden = !simulation;
  get('timeline-card').hidden = !simulation;
  playback.load(simulation, board, [...picker.options]);
  timeline(simulation);
  get('results').hidden = false;
}

function syncScenario() {
  const scenario = form.elements.scenario.value;
  form.elements.readPct.disabled = scenario === 'duplex';
  for (const key of ['readBytes', 'writeBytes']) {
    const field = form.elements[key];
    if (scenario === 'cpu-bar') {
      field.dataset.previous = field.value;
      field.value = '4';
      field.max = '8';
    } else {
      field.max = '65536';
      if (field.dataset.previous) field.value = field.dataset.previous;
      delete field.dataset.previous;
    }
  }
}

function syncRcBridgePreset() {
  const preset = rcBridgePreset(Number(form.elements.gen.value), Number(form.elements.lanes.value));
  form.elements.rcAxiWidthBits.value = preset.widthBits;
  form.elements.rcAxiClockGHz.value = preset.clockGHz;
  form.elements.rcBridgeBandwidthGBps.value = preset.bandwidthGBps;
  get('rc-axi-preset').textContent = `预设：${preset.widthBits} bit × ${preset.clockGHz} GHz = ${preset.interfacePeakGBps} GB/s 物理峰值；Bridge 有效上限 ${preset.bandwidthGBps} GB/s`;
}

function run() {
  playback.pause();
  worker?.terminate();
  result = undefined;
  get('download').disabled = true;
  get('results').hidden = true;
  delete status.dataset.error;
  status.textContent = '正在计算…';
  const fields = form.elements;
  const scenario = fields.scenario.value;
  const read = key => Number(fields[key].value);
  const flow = Object.fromEntries(['readPct', 'readBytes', 'writeBytes', 'count', 'intervalNs'].map(key => [key, read(key)]));
  const model = Object.fromEntries(['gen', 'lanes', 'tags', 'axiRead', 'axiWrite', 'creditReturnNs',
    'mps', 'mrrs', 'creditData'].map(key => [key, read(key)]));
  const cmnBandwidthGBps = read('cmnBandwidthGBps');
  const rcBridgeBandwidthGBps = read('rcBridgeBandwidthGBps');
  model.nodes = {
    'host.CMN': { bandwidth: cmnBandwidthGBps, writeGBps: cmnBandwidthGBps },
    'rc.AXI': { widthBits: read('rcAxiWidthBits'), clockGHz: read('rcAxiClockGHz'),
      bandwidth: rcBridgeBandwidthGBps, writeGBps: rcBridgeBandwidthGBps },
  };
  const flows = scenario === 'duplex' ? [
    { ...flow, scenario: 'p2p', readPct: 0 }, { ...flow, scenario: 'p2p-reverse', readPct: 100 },
  ] : [{ ...flow, scenario }];
  const fail = message => {
    status.dataset.error = '';
    status.textContent = `无法计算：${message}`;
  };
  try {
    const workerUrl = new URL('./worker.js', import.meta.url);
    workerUrl.searchParams.set('v', '20261119-rc-axi');
    worker = new Worker(workerUrl, { type: 'module' });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      worker = undefined;
      if (data.error) { fail(data.error); return; }
      result = data;
      render(data);
      get('download').disabled = false;
      status.textContent = data.simulation ?
        (data.simulation.stopReason === 'complete' ? `已完成 · ${format(data.simulation.events)} 个事件`
          : `部分结果 · ${data.simulation.stopReason} · ${data.simulation.pending} 笔在途`) : '已完成 · Gen6 解析预算';
    };
    worker.onerror = () => fail('无法加载模型，请通过本地 HTTP 服务打开页面');
    worker.postMessage({ flows, model });
  } catch (error) { fail(error.message); }
}

form.addEventListener('submit', event => { event.preventDefault(); run(); });
form.elements.scenario.addEventListener('change', syncScenario);
form.elements.gen.addEventListener('change', syncRcBridgePreset);
form.elements.lanes.addEventListener('change', syncRcBridgePreset);
get('trace-op').addEventListener('change', () => {
  playback.select(get('trace-op').value);
  timeline(result?.simulation);
});
get('trace-view').addEventListener('change', updateTraceView);
get('rtt-txn').addEventListener('change', updateTraceView);
get('download').addEventListener('click', () => {
  if (!result) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const link = element('a');
  link.href = url;
  link.download = 'pcie-performance.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
for (const key of ['tags', 'axiRead', 'axiWrite', 'creditReturnNs']) form.elements[key].value = DEFAULTS[key];
syncRcBridgePreset();
run();
