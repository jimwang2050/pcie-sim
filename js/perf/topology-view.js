import { profile } from './model.js';
import { eventName } from './event-inspector.js';

const ns = 'http://www.w3.org/2000/svg';

function draw(parent, tag, attrs = {}, text) {
  const item = document.createElementNS(ns, tag);
  for (const [name, value] of Object.entries(attrs)) item.setAttribute(name, value);
  if (text !== undefined) item.textContent = text;
  parent.append(item);
  return item;
}

const hostNodes = {
  'host.CPU': [58, 84, 100, 'CPU cores', 'Load / Store'],
  'cpu.AXI': [58, 151, 100, 'CPU Bridge', 'MMIO'],
  'host.DMA': [178, 84, 100, 'Host DMA', 'Copy engine'],
  'hostDMA.AXI': [178, 151, 100, 'DMA AXI', 'Read / Write'],
  'host.CMN': [58, 218, 220, 'CMN / CHI', '系统互连'],
  'rc.AXI': [300, 218, 78, 'RC Bridge', 'AXI / CHI'],
  'rc.CTL': [394, 218, 78, 'RP CTL', 'TL / DLL'],
  'rc.PHY': [488, 218, 60, 'RP PHY', 'SerDes'],
  'host.DDR': [58, 292, 145, 'DDR Controller', '主机内存服务'],
};
const epA = {
  'epA.PHY': [800, 218, 62, 'EP PHY', 'SerDes'],
  'epA.CTL': [881, 218, 86, 'EP CTL', 'TL / DLL'],
  'epA.AXI': [986, 218, 110, 'AXI Fabric', '本地互连'],
  'epA.DMA': [986, 132, 110, 'EP DMA', 'Requester'],
  'epA.HBM': [986, 292, 110, 'HBM / DDR', '内存窗口'],
  'epA.BAR': [862, 292, 100, 'BAR Target', 'MMIO'],
};
const switched = {
  'epA.DMA': [48, 132, 102, 'DMA A', 'Requester'],
  'epA.AXI': [48, 218, 102, 'AXI A', '本地互连'],
  'epA.CTL': [164, 218, 76, 'CTL A', 'TL / DLL'],
  'epA.PHY': [253, 218, 55, 'PHY A', 'SerDes'],
  'epA.HBM': [48, 292, 102, 'HBM / DDR', '目标窗口'],
  'swA.PHY': [444, 218, 61, 'Port A', 'PHY / DL'],
  'sw.fabric': [520, 218, 120, 'Switch Fabric', '路由 / 仲裁'],
  'swB.PHY': [655, 218, 61, 'Port B', 'PHY / DL'],
  'epB.PHY': [852, 218, 55, 'PHY B', 'SerDes'],
  'epB.CTL': [920, 218, 76, 'CTL B', 'TL / DLL'],
  'epB.AXI': [1010, 218, 102, 'AXI B', '本地互连'],
  'epB.DMA': [1010, 132, 102, 'DMA B', 'Requester'],
  'epB.HBM': [1010, 292, 102, 'HBM / DDR', '目标窗口'],
};
const linkNames = {
  'epA>rc': 'EP A → RP', 'rc>epA': 'RP → EP A', 'epA>sw': 'EP A → Switch',
  'sw>epA': 'Switch → EP A', 'epB>sw': 'EP B → Switch', 'sw>epB': 'Switch → EP B',
};
const nodeNames = Object.fromEntries([hostNodes, epA, switched]
  .flatMap(group => Object.entries(group).map(([id, [, , , title]]) => [id, title])));

export function nodeLabel(id) {
  return linkNames[id] ?? nodeNames[id] ?? id;
}

export function drawTopology(host, budget, simulation, select, format) {
  const p2p = budget.flows[0].scenario.startsWith('p2p');
  const nodes = p2p ? switched : { ...hostNodes, ...epA };
  const layout = p2p ? [
    [27, 61, 289, 301, 'ENDPOINT A', 'PCIe EP'],
    [434, 61, 292, 301, 'PCIe SWITCH', '独立端口 · 共享 Fabric'],
    [844, 61, 289, 301, 'ENDPOINT B', 'PCIe EP'],
  ] : [[27, 61, 532, 301, 'HOST SoC', 'CPU / CMN / Root Complex'],
    [790, 61, 342, 301, 'ENDPOINT A', 'PCIe EP · DMA / BAR / Memory']];
  const cables = p2p ? [
    ['epA.PHY', 'swA.PHY', 'epA>sw', 'sw>epA'],
    ['swB.PHY', 'epB.PHY', 'sw>epB', 'epB>sw'],
  ] : [['rc.PHY', 'epA.PHY', 'rc>epA', 'epA>rc']];
  const activity = new Map();
  const rttMarks = new Map();
  const mark = (id, label) => rttMarks.set(id, [...(rttMarks.get(id) ?? []), label]);
  const edges = new Map();
  const active = new Set();
  function path(ids, type) {
    for (const [index, id] of ids.entries()) {
      if (id.includes('>')) {
        if (!activity.has(id)) activity.set(id, new Set());
        activity.get(id).add(type);
        continue;
      }
      active.add(id);
      const previous = ids[index - 1];
      if (previous && !previous.includes('>')) {
        const key = [id, previous].sort().join('/');
        edges.set(key, [previous, id]);
      }
    }
  }
  for (const { id, path: route, bytes } of budget.flows) {
    const request = [route.source, route.bridge, ...route.route, route.target];
    if (bytes.read) {
      const suffix = budget.flows.length > 1 ? `·${id}` : '';
      mark(route.route.find(key => key.includes('>')), `t₀${suffix}`);
      mark(route.returnRoute.findLast(key => key.includes('>')), `tCpl${suffix}`);
      path(request, 'MRd');
      path([route.target, ...route.returnRoute, route.bridge, route.source], 'CplD');
      if (route.localCopy.length) path([route.source, route.bridge, ...route.localCopy], 'local');
    }
    if (bytes.write) {
      path(request, 'MWr');
      if (route.localCopy.length) path([...route.localCopy].reverse().concat(route.bridge, route.source), 'local');
    }
  }
  const wrap = document.createElement('div');
  wrap.className = 'board-scroll';
  host.append(wrap);
  const svg = draw(wrap, 'svg', { viewBox: '0 0 1160 396', class: 'board', role: 'group', 'aria-label': 'PCIe 硬件拓扑' });
  const defs = draw(svg, 'defs');
  const grid = draw(defs, 'pattern', { id: 'board-grid', width: 20, height: 20, patternUnits: 'userSpaceOnUse' });
  draw(grid, 'circle', { cx: 1, cy: 1, r: 1, fill: '#294462' });
  draw(svg, 'rect', { width: 1160, height: 396, rx: 12, class: 'board-base' });
  draw(svg, 'rect', { width: 1160, height: 396, rx: 12, fill: 'url(#board-grid)' });
  for (const [x, y, width, height, title, description] of layout) {
    draw(svg, 'rect', { x, y, width, height, rx: 10, class: 'chip' });
    draw(svg, 'text', { x: x + 15, y: y - 23, class: 'chip-title' }, title);
    draw(svg, 'text', { x: x + 15, y: y - 7, class: 'chip-subtitle' }, description);
  }
  if (!p2p) {
    draw(svg, 'rect', { x: 291, y: 184, width: 265, height: 97, rx: 9, class: 'chip-subgroup' });
    draw(svg, 'text', { x: 301, y: 205, class: 'chip-subtitle' }, 'ROOT COMPLEX / ROOT PORT');
  }
  const busGap = 2.2;
  for (const [from, to] of edges.values()) {
    const [ax, ay, aw] = nodes[from];
    const [bx, by, bw] = nodes[to];
    const x1 = ax + aw / 2, x2 = bx + bw / 2, y1 = ay + 23, y2 = by + 23;
    const middle = (y1 + y2) / 2;
    const rail = offset => `M${x1 + offset} ${y1} V${middle + offset} H${x2 + offset} V${y2}`;
    draw(svg, 'path', { d: rail(-busGap), class: 'internal-bus' });
    draw(svg, 'path', { d: rail(busGap), class: 'internal-bus return' });
    const arrow = (x, y, dx, dy) => {
      const px = -dy, py = dx;
      draw(svg, 'path', { class: 'internal-arrow',
        d: `M${x - dx * 4 + px * 3} ${y - dy * 4 + py * 3} L${x} ${y} L${x - dx * 4 - px * 3} ${y - dy * 4 - py * 3}` });
    };
    if (Math.abs(x2 - x1) >= 20) {
      const direction = x2 > x1 ? 1 : -1;
      const center = (x1 + x2) / 2;
      arrow(center, middle - busGap, direction, 0);
      arrow(center, middle + busGap, -direction, 0);
    } else {
      const direction = y2 > y1 ? 1 : -1;
      const center = (y1 + y2) / 2;
      arrow(x1 - busGap, center, 0, direction);
      arrow(x2 + busGap, center, 0, -direction);
    }
  }
  const controls = [];
  const locations = new Map();
  function interactive(parent, id, label) {
    const group = draw(parent, 'g', { role: 'button', tabindex: 0, 'aria-label': label, 'aria-pressed': 'false', 'data-node': id });
    controls.push(group);
    const activate = (inspect = false) => {
      for (const control of controls) control.setAttribute('aria-pressed', String(control === group));
      select(label, id, inspect);
    };
    group.addEventListener('click', () => activate(true));
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(true); }
    });
    return [group, activate];
  }
  let selected;
  for (const [first, second, forward, reverse] of cables) {
    const [ax, ay, aw] = nodes[first];
    const [bx] = nodes[second];
    const start = ax + aw, end = bx, center = (start + end) / 2;
    draw(svg, 'text', { x: center, y: ay - 49, 'text-anchor': 'middle', class: 'cable-title' },
      `Gen${budget.model.gen} ×${budget.model.lanes}`);
    draw(svg, 'text', { x: center, y: ay - 33, 'text-anchor': 'middle', class: 'chip-subtitle' },
      `每向 ${format(budget.link.budgetGBps)} GB/s`);
    draw(svg, 'text', { x: center, y: ay - 19, 'text-anchor': 'middle', class: 'factor-label' },
      `FC ${budget.model.creditHeaders}H/${budget.model.creditData}D · ${budget.model.creditReturnNs}ns`);
    draw(svg, 'text', { x: center, y: ay - 6, 'text-anchor': 'middle', class: 'factor-label' },
      `传播 ${budget.model.propagationNs} ns`);
    for (const [index, id] of [forward, reverse].entries()) {
      const y = ay + 13 + index * 23;
      const kinds = activity.get(id) ?? new Set();
      const wire = simulation?.resources.find(item => item.id === id);
      const endpoints = id.split('>').map(key => ({ epA: 'EP A', epB: 'EP B', sw: 'Switch', rc: 'RP' })[key]);
      const [group, activate] = interactive(svg, id, endpoints.join(' → '));
      if (!selected && kinds.size) selected = activate;
      const klass = kinds.has('MWr') && kinds.has('CplD') ? 'shared' : kinds.has('MWr') ? 'posted' :
        kinds.has('CplD') ? 'completion' : kinds.size ? 'request' : 'idle';
      group.setAttribute('class', `wire ${klass}`);
      group.setAttribute('data-capacity', budget.link.budgetGBps);
      if (budget.bounds[0]?.id === id || budget.bounds[0]?.id.startsWith(`${id}:`)) group.dataset.bottleneck = '';
      group.setAttribute('data-traffic', [...kinds].sort().join(' '));
      draw(group, 'rect', { x: start, y: y - 10, width: end - start, height: 21, rx: 3, class: 'wire-hit' });
      draw(group, 'path', { d: `M${start} ${y} H${end}`, class: 'wire-trace' });
      const tip = index ? start + 5 : end - 5, tail = tip + (index ? 8 : -8);
      locations.set(id, { x: index ? end : start, to: index ? start : end, y, group });
      draw(group, 'path', { d: `M${tail} ${y - 5} L${tip} ${y} L${tail} ${y + 5}`, class: 'wire-trace' });
      const direction = index ? -1 : 1;
      const arrowX = center + direction * 52;
      draw(group, 'path', { d: `M${arrowX - direction * 9} ${y - 6} L${arrowX} ${y} L${arrowX - direction * 9} ${y + 6} Z`,
        class: 'wire-direction-arrow' });
      draw(group, 'text', { x: start + 9, y: y + 3.5, class: 'wire-end-label' }, index ? 'RX' : 'TX');
      draw(group, 'text', { x: end - 9, y: y + 3.5, 'text-anchor': 'end', class: 'wire-end-label' }, index ? 'TX' : 'RX');
      const labelY = y + (index ? 13 : -13);
      draw(group, 'rect', { x: center - 34, y: labelY - 7, width: 68, height: 14, rx: 4, class: 'wire-label' });
      draw(group, 'text', { x: center, y: labelY + 3.5, 'text-anchor': 'middle', class: 'wire-value' },
        wire ? `${format(wire.measuredUtilization * 100)}%` : kinds.size ? [...kinds].join('+') : '空闲');
      draw(group, 'title', {}, `${id} · ${[...kinds].join(' + ') || '空闲'}` +
        `${wire ? ` · 实测 ${format(wire.measuredGBps)} GB/s（${format(wire.measuredUtilization * 100)}%）` : ''}` +
        ` · 每向容量 ${format(budget.link.budgetGBps)} GB/s`);
      draw(svg, 'text', { x: center, y: ay + 66 + index * 15, 'text-anchor': 'middle', class: 'chip-subtitle' },
        `${index ? 'RX ← TX' : 'TX → RX'} · ${[...kinds].join(' + ') || '空闲'}`);
      const marks = rttMarks.get(id);
      if (marks?.length) {
        const markX = marks[0].startsWith('t₀') === (index === 0) ? start + 7 : end - 7;
        draw(svg, 'circle', { cx: markX, cy: y, r: 4, class: 'metric-probe' });
        draw(svg, 'text', { x: center, y: ay + 104 + index * 14, 'text-anchor': 'middle',
          class: 'metric-probe-label', 'data-rtt-link': id }, marks.join(' / '));
      }
    }
  }
  const model = budget.model;
  const requesters = new Set(budget.flows.map(flow => flow.path.requester));
  const requesterOf = { 'rc.CTL': ['cpu', 'hostDMA'], 'epA.CTL': ['epA'], 'epB.CTL': ['epB'] };
  const targets = new Set(budget.flows.flatMap(flow => [flow.path.target, ...flow.path.localCopy.filter(id => id.endsWith('.DDR'))]));
  for (const [id, [x, y, width, title, subtitle]] of Object.entries(nodes)) {
    const [group] = interactive(svg, id, `${title} · ${id}`);
    group.setAttribute('class', active.has(id) ? 'hardware active' : 'hardware inactive');
    const node = profile(model, id);
    const bridgeOwner = budget.flows.find(flow => flow.path.bridge === id);
    const tags = requesterOf[id]?.some(key => requesters.has(key));
    const factors = id === 'rc.AXI' ? [`AXI ${node.widthBits}b @ ${format(node.clockGHz)}G`,
      `${format(node.interfacePeakGBps)} → ${format(node.bandwidth)} GB/s`] :
      tags ? [`Tag ${model.tags}`, `MRRS ${model.mrrs} B`] :
      id.endsWith('.CTL') ? [`MPS ${model.mps} B`, `L₀ ${node.latencyNs} ns`] :
      bridgeOwner ? [`R/W 并发 ${model.axiRead}/${model.axiWrite}`, `Burst ≤ ${model.axiBurstBytes} B`] :
      id.endsWith('.DMA') ? [`窗口 ${model.dmaOps} 笔`, `${format(model.dmaBytes / 1024)} KiB 在途`] :
      targets.has(id) ? [`R/W ${node.bandwidth}/${node.writeGBps} GB/s`, `L₀ ${node.latencyNs} ns`] :
      [`L₀ ${node.latencyNs} ns`, ...(width >= 76 ? [`${node.bandwidth} GB/s`] : [])];
    draw(group, 'rect', { x, y, width, height: 62, rx: 5, class: 'hardware-body' });
    draw(group, 'text', { x: x + width / 2, y: y + 18, 'text-anchor': 'middle', class: 'hardware-title' }, title);
    draw(group, 'text', { x: x + width / 2, y: y + 31, 'text-anchor': 'middle', class: 'chip-subtitle' }, subtitle);
    factors.forEach((factor, index) => draw(group, 'text', {
      x: x + width / 2, y: y + 44 + index * 12, 'text-anchor': 'middle', class: 'factor-label',
    }, factor));
    const suffixes = new Set(['tx', 'rx', 'AR', 'W', 'R', 'B', 'request', 'response']);
    const pools = simulation?.resources.filter(item => item.id === id ||
      (item.id.startsWith(`${id}:`) && suffixes.has(item.id.slice(id.length + 1)))) ?? [];
    const load = pools.length ? pools.reduce((sum, item) => sum + (item.utilization ?? 0), 0) / pools.length : 0;
    const waitNs = pools.reduce((sum, item) => sum + (item.waitNs ?? 0), 0);
    group.dataset.load = format(Math.min(1, load) * 100);
    if (pools.length) group.dataset.wait = format(waitNs);
    draw(group, 'rect', { x: x + 4, y: y + 64, width: width - 8, height: 2.5, rx: 1.25, class: 'load-track' });
    if (load > 0) {
      draw(group, 'rect', { x: x + 4, y: y + 64, width: (width - 8) * Math.min(1, load), height: 2.5, rx: 1.25,
        class: `load-fill ${load >= .8 ? 'high' : load >= .5 ? 'mid' : 'low'}` });
    }
    draw(group, 'title', {}, `${title} · ${id}` +
      `${pools.length ? ` · 占用 ${format(Math.min(1, load) * 100)}%` : ''}` +
      `${waitNs ? ` · 累计等待 ${format(waitNs)} ns` : ''}`);
    const resourceKeys = [id];
    if (bridgeOwner) resourceKeys.push(...['axi-read', 'axi-write'].map(key => `${bridgeOwner.path.requester}:${key}`));
    for (const requester of requesterOf[id] ?? []) {
      resourceKeys.push(...['tags', 'completion', 'write-buffer'].map(key => `${requester}:${key}`));
    }
    const bottleneck = budget.bounds[0]?.id;
    if (resourceKeys.some(key => bottleneck === key || bottleneck?.startsWith(`${key}:`))) {
      group.dataset.bottleneck = '';
      draw(group, 'text', { x: x + width - 5, y: y + 10, 'text-anchor': 'end', class: 'bottleneck-tag' }, '瓶颈');
    }
    locations.set(id, { x: x + width / 2, y: y + 21, lower: y + 62, group });
  }
  const overlay = draw(svg, 'g', { 'aria-hidden': 'true', class: 'flow-overlay' });
  const milestones = draw(svg, 'g', { class: 'txn-milestones', 'aria-label': '事务里程碑' });
  const rulers = draw(svg, 'g', { class: 'rtt-rulers', 'aria-label': '静态 RTT 延时构成' });
  const tooltip = draw(svg, 'g', { class: 'step-callout', 'data-testid': 'step-callout', hidden: '' });
  const pointer = draw(tooltip, 'path', { class: 'step-pointer' });
  const box = draw(tooltip, 'g');
  draw(box, 'rect', { width: 258, height: 70, rx: 8 });
  const title = draw(box, 'text', { x: 12, y: 17, class: 'step-title' });
  const summary = draw(box, 'text', { x: 12, y: 36 });
  const context = draw(box, 'text', { x: 12, y: 54 });
  let paintedStep;
  let staticMode = false;
  function locationFor(event) {
    if (!event) return undefined;
    const key = event.node ?? event.resource.split(':')[0];
    if (locations.has(key)) return locations.get(key);
    const owner = budget.flows.find(flow => flow.path.requester === key);
    return locations.get(owner?.path.route.find(id => id.endsWith('.CTL'))) ??
      locations.get(owner?.path.bridge);
  }
  function showStep(step) {
    if (!step || step.index === paintedStep && step.events === tooltip.events) return;
    paintedStep = step.index;
    tooltip.events = step.events;
    const events = step.events;
    const priority = ['block', 'mrd-tx-start', 'cpl-rx-end', 'tag-allocated', 'target-visible', 'local-accepted',
      'completion-arrived', 'submit', 'service', 'arrive', 'grant', 'release', 'enqueue', 'done'];
    const event = priority.map(type => events.find(item => item.event === type)).find(Boolean);
    tooltip.toggleAttribute('hidden', !event);
    if (!event) return;
    const location = locationFor(event);
    const anchor = location ? (location.x + (location.to ?? location.x)) / 2 : 580;
    const y = location?.y ?? 132;
    const left = Math.max(12, Math.min(890, anchor - 129));
    const top = y >= 145 ? y - 92 : y + 18;
    const edge = y >= 145 ? top + 70 : top;
    pointer.setAttribute('d', `M${anchor} ${y} L${anchor} ${edge}`);
    box.setAttribute('transform', `translate(${left} ${top})`);
    title.textContent = `第 ${step.index}/${step.count} 步 · +${format(step.offset)} ns`;
    summary.textContent = `${eventName(event)}${event.packetClass ? ` · ${{ NP: 'MRd', P: 'MWr', Cpl: 'CplD', read: '读', write: '写' }[event.packetClass]}` : ''}`;
    const detail = event.tag != null ? `Tag ${event.tag}` : event.waitNs ? `等待 ${format(event.waitNs)} ns` : '';
    context.textContent = [event.resource, detail, events.length > 1 ? `+${events.length - 1} 条同刻事件` : ''].filter(Boolean).join(' · ');
  }
  selected?.();
  const render = (services, atNs, step) => {
    if (staticMode) return;
    showStep(step);
    overlay.replaceChildren();
    for (const { group } of locations.values()) group.removeAttribute('data-playing');
    for (const badge of milestones.querySelectorAll('[data-at]')) {
      badge.classList.toggle('reached', Number(badge.dataset.at) <= atNs);
      badge.classList.toggle('current', Number(badge.dataset.at) === atNs);
    }
    const counts = new Map();
    for (const service of services) {
      const location = locations.get(service.node);
      if (!location) continue;
      location.group.setAttribute('data-playing', '');
      const count = counts.get(service.node) ?? 0;
      counts.set(service.node, count + 1);
      if (count >= 5) continue;
      const { x, y, to } = location;
      const elapsed = (atNs - service.atNs) / service.durationNs;
      const color = { NP: 'request', P: 'posted', Cpl: 'completion', read: 'request', write: 'posted' }[service.packetClass];
      const point = to === undefined ? x + (count - 1) * 12 : x + (to - x) * elapsed;
      const badge = draw(overlay, 'circle', { cx: point, cy: y + (to === undefined ? 0 : (count % 3 - 1) * 4),
        r: service.packetClass === 'NP' ? 4 : 5.5, class: color ?? 'request',
        'data-packet': service.packetClass, 'data-resource': service.node });
      if (service.packetClass === 'NP') badge.setAttribute('fill-opacity', '.35');
    }
  };
  render.rtt = (breakdown, enabled) => {
    staticMode = enabled;
    rulers.replaceChildren();
    milestones.style.display = enabled ? 'none' : '';
    tooltip.style.display = enabled ? 'none' : '';
    overlay.style.display = enabled ? 'none' : '';
    svg.setAttribute('viewBox', enabled && breakdown ? '0 0 1160 670' : '0 0 1160 396');
    for (const { group } of locations.values()) group.removeAttribute('data-playing');
    if (!enabled || !breakdown) return;
    const offset = breakdown.phases[0].from.atNs;
    const total = Math.max(breakdown.lastNs, 1);
    const axis = time => 40 + (time - offset) * 1080 / total;
    const section = draw(rulers, 'g', { class: 'rtt-sheet' });
    draw(section, 'rect', { x: 12, y: 438, width: 1136, height: 222, rx: 9 });
    draw(section, 'text', { x: 40, y: 455, class: 'rtt-caption' },
      `${breakdown.id} · Tag ${breakdown.tag} · 末片 RTT ${format(breakdown.lastNs)} ns`);
    const [request, target, reply, tail] = breakdown.phases;
    const joined = tail.ns === 0;
    const points = [
      { id: 'A', event: request.from, label: 'MRd 发出' },
      { id: 'B', event: target.from, label: '目标开始' },
      { id: 'C', event: target.to, label: '目标结束' },
      { id: 'D', event: reply.to, label: joined ? '首片＝末片' : '首片 CplD' },
      ...(!joined ? [{ id: 'E', event: tail.to, label: '末片 CplD' }] : []),
    ];
    const guides = draw(rulers, 'g', { class: 'rtt-guides' });
    const marks = draw(rulers, 'g', { class: 'rtt-points' });
    const timelineY = 485;
    const pointX = point => axis(point.event.atNs);
    draw(guides, 'path', { d: 'M40 485 H1120', class: 'rtt-axis' });
    const badge = (x, y, id, position) => {
      const group = draw(marks, 'g', { 'data-rtt-point': id, 'data-location': position });
      draw(group, 'circle', { cx: x, cy: y, r: 8 });
      draw(group, 'text', { x, y: y + 3.5, 'text-anchor': 'middle' }, id);
      return group;
    };
    for (const [index, point] of points.entries()) {
      const endpoint = locationFor(point.event);
      if (!endpoint) continue;
      const sourceX = endpoint.to === undefined ? endpoint.x + (point.id === 'B' ? -16 : 16) :
        point.id === 'A' ? endpoint.x : endpoint.to;
      const sourceY = endpoint.lower ?? endpoint.y;
      const secondReply = point.id === 'E';
      const badgeX = sourceX + (secondReply ? (endpoint.x < endpoint.to ? -18 : 18) : 0);
      const badgeY = sourceY + (secondReply ? 17 : 0);
      const laneY = 392 + index * 9;
      const x = pointX(point);
      draw(guides, 'path', { d: `M${badgeX} ${badgeY} V${laneY} H${x} V${timelineY}`,
        class: `rtt-guide guide-${point.id}`, 'data-guide': point.id });
      if (secondReply) draw(guides, 'path', { d: `M${sourceX} ${sourceY} L${badgeX} ${badgeY}`, class: 'rtt-local-leader' });
      const hardware = badge(badgeX, badgeY, point.id, 'hardware');
      draw(hardware, 'title', {}, `${point.id} · ${point.label} · ${point.event.resource}`);
      const time = badge(x, timelineY, point.id, 'time');
      draw(time, 'title', {}, `${point.label} · +${format(point.event.atNs - offset)} ns`);
    }
    for (const [index, phase] of breakdown.phases.entries()) {
      const color = `rtt-${phase.key}`;
      const y = 516 + index * 36;
      const left = axis(phase.from.atNs);
      const right = axis(phase.to.atNs);
      const labelX = Math.min(930, Math.max(40, left));
      const band = draw(section, 'g', { class: color, 'data-phase': phase.key });
      const pair = ['A → B', 'B → C', 'C → D', joined ? 'D → D' : 'D → E'][index];
      draw(band, 'text', { x: labelX, y: y - 5 }, `${pair}  ${phase.label} · ${format(phase.ns)} ns`);
      if (phase.ns > 0) {
        draw(band, 'path', { d: `M${left} ${timelineY + 8} V${y + 2} M${right} ${timelineY + 8} V${y + 2}`, class: 'rtt-projection' });
        draw(band, 'path', { d: `M${left} ${y + 2} v9 m0 -4.5 H${right} m0 -4.5 v9`, class: 'rtt-measure' });
      }
    }
  };
  render.mark = (events, onSelect) => {
    milestones.replaceChildren();
    const positions = new Map();
    for (const [index, event] of events.entries()) {
      const location = locationFor(event);
      if (!location) continue;
      const { x, to, y } = location;
      const count = positions.get(location) ?? 0;
      positions.set(location, count + 1);
      const center = to === undefined ? x + (count % 4 - 1.5) * 18 :
        event.event === 'mrd-tx-start' || event.event === 'service' ? x + Math.sign(to - x) * (12 + count * 18) :
          to - Math.sign(to - x) * (12 + count * 18);
      const top = to === undefined ? y - 26 - Math.floor(count / 4) * 18 : y - 11;
      const badge = draw(milestones, 'g', { class: `txn-pin ${event.kind}`, role: 'button', tabindex: 0,
        'data-at': event.atNs, 'data-stop': index, 'aria-pressed': 'false',
        'aria-label': `里程碑 ${index + 1}：${eventName(event)} · ${event.resource}` });
      draw(badge, 'circle', { cx: center, cy: top, r: 8 });
      draw(badge, 'text', { x: center, y: top + 3, 'text-anchor': 'middle' }, index + 1);
      badge.addEventListener('click', () => onSelect(index));
      badge.addEventListener('keydown', key => {
        if (key.key === 'Enter' || key.key === ' ') { key.preventDefault(); onSelect(index); }
      });
    }
  };
  render.selectMilestone = index => {
    for (const badge of milestones.querySelectorAll('[data-stop]')) {
      badge.setAttribute('aria-pressed', String(Number(badge.dataset.stop) === index));
    }
  };
  render.focus = id => {
    for (const { group } of locations.values()) group.classList.remove('hop-focus');
    const location = id && locations.get(id);
    location?.group.classList.add('hop-focus');
    return Boolean(location);
  };
  return render;
}
