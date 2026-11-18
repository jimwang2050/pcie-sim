import { nodeLabel } from './topology-view.js';

const roles = { request: '去程', target: '目标', return: '回程', pre: '发起', post: '接收' };
const shortNames = {
  'epA>rc': 'Link', 'rc>epA': 'Link', 'epA>sw': 'Link', 'sw>epA': 'Link', 'epB>sw': 'Link', 'sw>epB': 'Link',
  'rc.PHY': 'PHY', 'epA.PHY': 'PHY', 'epB.PHY': 'PHY', 'swA.PHY': 'PHY A', 'swB.PHY': 'PHY B',
  'rc.CTL': 'CTL', 'epA.CTL': 'CTL', 'epB.CTL': 'CTL', 'rc.AXI': 'AXI', 'cpu.AXI': 'CPU AXI',
  'hostDMA.AXI': 'DMA AXI', 'epA.AXI': 'AXI', 'epB.AXI': 'AXI', 'host.CMN': 'CMN',
  'host.DDR': 'DDR', 'epA.HBM': 'HBM', 'epB.HBM': 'HBM', 'epA.BAR': 'BAR',
  'epA.DMA': 'DMA', 'epB.DMA': 'DMA', 'sw.fabric': 'Fabric',
};
const shortLabel = id => shortNames[id] ?? nodeLabel(id);

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

export function createLatencyView(get, format, focus) {
  return composition => {
    const host = get('latency-compose');
    host.hidden = !composition;
    if (!composition) { focus(null); return; }
    const first = Math.max(composition.firstNs, 1e-9);
    const last = Math.max(composition.lastNs, 1e-9);

    get('compose-scope').textContent = `${composition.id} · Tag ${composition.tag} · ` +
      `${nodeLabel(composition.window.start)} → ${nodeLabel(composition.window.target)} → ` +
      `${nodeLabel(composition.window.end)}`;

    const bar = get('compose-bar');
    bar.replaceChildren();
    const segment = (hop, role, label, ns) => {
      const button = element('button', `compose-seg ${role}`);
      button.type = 'button';
      button.style.width = `${Math.min(100, ns / last * 100)}%`;
      button.dataset.role = role;
      if (hop) button.dataset.hop = hop.node;
      button.setAttribute('aria-label', `${label} ${format(ns)} ns`);
      const detail = hop ? `（等待 ${format(hop.waitNs)} ns + 传输 ${format(hop.transitNs)} ns）` : '';
      button.title = `${label} · ${format(ns)} ns${detail}`;
      if (hop?.waitNs > 0) {
        const wait = element('span', 'seg-wait');
        wait.style.width = `${hop.waitNs / (hop.waitNs + hop.transitNs) * 100}%`;
        button.append(wait);
      }
      if (ns / last >= 0.032) button.append(element('span', 'seg-label', hop ? shortLabel(hop.node) : label));
      button.addEventListener('click', () => focus(hop?.node ?? null));
      bar.append(button);
    };
    for (const hop of composition.hops) {
      segment(hop, hop.role, nodeLabel(hop.node), hop.waitNs + hop.transitNs);
    }
    if (composition.tailNs > 0) segment(null, 'tail', '尾片', composition.tailNs);

    const legend = get('compose-legend');
    const keys = [...new Set(composition.hops.map(hop => hop.role))].map(role => [role, roles[role]]);
    if (composition.tailNs > 0) keys.push(['tail', '首片 → 末片']);
    if (composition.hops.some(hop => hop.waitNs > 0)) keys.push(['wait', '准入等待 Q']);
    legend.replaceChildren(...keys.map(([role, label]) => element('span', `compose-key ${role}`, label)));

    const top = [...composition.hops]
      .sort((firstHop, secondHop) =>
        (secondHop.waitNs + secondHop.transitNs) - (firstHop.waitNs + firstHop.transitNs))[0];
    get('compose-summary').textContent = `首片 RTT ${format(composition.firstNs)} ns = ` +
      `等待 Q ${format(composition.totals.waitNs)} ns + 逐跳传输 ${format(composition.totals.transitNs)} ns；` +
      `末片 RTT ${format(composition.lastNs)} ns${composition.tailNs > 0 ? `（尾片 ${format(composition.tailNs)} ns）` : ''}。` +
      (top ? ` 最大单跳 ${nodeLabel(top.node)} ${format(top.waitNs + top.transitNs)} ns` +
        `（${format((top.waitNs + top.transitNs) / first * 100)}%）。` : '');
    const total = hops => hops.reduce((sum, hop) => sum + hop.waitNs + hop.transitNs, 0);
    const { pre, post, submitAt } = composition.context;
    get('compose-context').textContent = pre.length || post.length ?
      `窗口外：发起端 ${format(total(pre))} ns、接收端 ${format(total(post))} ns` +
        `${submitAt != null && post.length ? ` → 提交到首片抵达请求方 ${format(post.at(-1).endNs - submitAt)} ns` : ''}。` +
        '发起/接收段不计入 RTT 口径，但与整笔端到端延迟直接相关。' :
      'RTT 窗口外没有额外发起/接收段。';

    const container = get('compose-hops');
    container.replaceChildren();
    const table = headers => {
      const grid = element('table');
      const head = grid.createTHead().insertRow();
      for (const label of headers) head.append(element('th', undefined, label));
      return { grid, body: grid.createTBody() };
    };
    const appendGrid = (grid, before) => {
      if (before) container.append(before);
      const wrap = element('div', 'scroll');
      wrap.append(grid);
      container.append(wrap);
    };
    const row = (body, cells, hop, note) => {
      const line = body.insertRow();
      for (const value of cells) line.insertCell().textContent = value;
      if (!hop?.node) return;
      line.dataset.hop = hop.node;
      line.tabIndex = 0;
      line.classList.add('compose-row');
      line.title = note;
      line.setAttribute('aria-label', `${nodeLabel(hop.node)}，${note}`);
      line.addEventListener('click', () => focus(hop.node));
      line.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focus(hop.node); }
      });
    };
    const { grid, body } = table(['段', '硬件', 'Q 等待 ns', 'L₀ ns', '串行化 ns', '切换 ns', '合计 ns', '占首片']);
    for (const hop of composition.hops) {
      const ns = hop.waitNs + hop.transitNs;
      row(body, [roles[hop.role], nodeLabel(hop.node), format(hop.waitNs), format(hop.latencyNs),
        format(hop.serializationNs), format(hop.turnaroundNs), format(ns), `${format(ns / first * 100)}%`], hop,
      `${roles[hop.role]} ${hop.node}：等待 ${format(hop.waitNs)} ns + 传输 ${format(hop.transitNs)} ns`);
    }
    if (composition.tailNs > 0) {
      row(body, ['尾片', 'Completion 首片 → 末片', '—', '—', '—', '—', format(composition.tailNs), '—'], null, '');
    }
    const foot = body.insertRow();
    foot.className = 'compose-total';
    foot.append(element('td', undefined, '首片 RTT'), element('td', undefined, '逐跳合计'),
      element('td', undefined, format(composition.totals.waitNs)),
      element('td', undefined, format(composition.totals.latencyNs)),
      element('td', undefined, format(composition.totals.serializationNs)),
      element('td', undefined, format(composition.totals.turnaroundNs)),
      element('td', undefined, format(composition.firstNs)), element('td', undefined, '100%'));
    appendGrid(grid);

    if (pre.length || post.length) {
      const context = table(['段', '硬件', 'Q 等待 ns', 'L₀ ns', '串行化 ns', '切换 ns', '合计 ns', '说明']);
      for (const hop of pre) {
        row(context.body, [roles.pre, nodeLabel(hop.node), format(hop.waitNs), format(hop.latencyNs),
          format(hop.serializationNs), format(hop.turnaroundNs), format(hop.waitNs + hop.transitNs), '不计入 RTT'], hop,
        `发起段 ${hop.node}：${format(hop.waitNs + hop.transitNs)} ns`);
      }
      for (const hop of post) {
        row(context.body, [roles.post, nodeLabel(hop.node), format(hop.waitNs), format(hop.latencyNs),
          format(hop.serializationNs), format(hop.turnaroundNs), format(hop.waitNs + hop.transitNs), '不计入 RTT'], hop,
        `接收段 ${hop.node}：${format(hop.waitNs + hop.transitNs)} ns`);
      }
      appendGrid(context.grid, element('p', 'hint', '窗口外逐跳（理解整条业务流，不计入上面的 RTT）：'));
    }
  };
}
