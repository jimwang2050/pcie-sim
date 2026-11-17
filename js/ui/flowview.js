/**
 * 流程视图：X 轴为组件（RP / Link / EP），Y 轴为时间/阶段。
 * 每个组件按协议层次（TL / DL / PHY）拆分子列，只展示当前场景实际涉及的层次；
 * 组件表头固定（sticky），页面只做纵向滚动；阶段用虚线框归类，控制/数据流以小方框标注。
 */

const DEFAULT_W = 780;
const HEAD_H = 66;
const TOP = 46;
const ROW = 54;

const LAYERS = ['TL', 'DL', 'PHY'];
const LAYER_META = {
  TL: { title: 'TL', detail: '事务层', color: '#60a5fa' },
  DL: { title: 'DL', detail: '数据链路层', color: '#22d3ee' },
  PHY: { title: 'PHY', detail: '物理层', color: '#fbbf24' },
};

const FLOW_DEF = {
  link_training: 'RP 与 EP 通过 TS1/TS2 协商速率与宽度，Configuration 完成后进入 L0。',
  ltssm_pm: 'L1 由 CLKREQ# 唤醒、L2 由 Beacon 唤醒；热插拔经 PRSNT# → 上电 → PERST# → 训练 → DLLSC 通知软件。',
  phy_link: 'REF CLK / PLL 提供时钟，CDR 锁定后发送端 EQ 收敛，眼图与 COM 改善。',
  loopback_bert: 'Internal 与 External 是两套独立环回配置（顶栏切换，一次只跑一种），各自完成 BERT 测量。',
  flit_gen6: '256B Flit 承载多个 TLP，经 FEC/CRC 校验后按 Flit 粒度重传。',
  enumeration: 'RP 读/写 EP 配置空间，探测 BAR 大小并分配基址。',
  mem_read: 'RP 发 MRd，EP 返回 CplD；Tag 匹配请求与完成。',
  mem_write: 'RP 发 Posted MWr，EP 写入内存并归还 P 信用。',
  msi_int: 'EP 通过 Posted MWr 写 MSI/MSI-X 地址，触发 RP 中断。',
  aer_error: 'EP 检测错误并通过 Message 上报，最后经 Hot Reset 恢复。',
  dpc_rpio: 'RP 检测不可纠正错误 → DPC 隔离链路 → Egress Control 阻止下泄、RP PIO 按严重级别终止 PIO 请求 → 软件清除后复位恢复。',
  ats: 'EP 发 Translation Request → RC/IOMMU 返回翻译 → ATC 缓存命中/失效 → 缺页经 Page Request / PRG Response 重试。',
  pm_dp: 'PMCSR 控制 D 状态；PME 唤醒；D3cold 需 Fundamental Reset。',
};

const CONTROL_TYPES = new Set([
  'CfgRd0', 'CfgWr0', 'CfgRd1', 'CfgWr1', 'Msg', 'MSG', 'Ack', 'ACK', 'NAK',
  'InitFC1', 'InitFC2', 'UpdateFC', 'TS1', 'TS2', 'SKP', 'PM', 'PM_PME',
  'INT', 'ERR_COR', 'ERR_NONFATAL', 'ERR_FATAL', 'LOOPBACK', 'HOTRESET',
  'RETRY', 'DONE', 'TR', 'TC', 'INV', 'INVC', 'PRQ', 'PRG',
]);
const DATA_TYPES = new Set(['MRd', 'MWr', 'Cpl', 'CplD', 'FLIT']);

const TL_TYPES = new Set([
  'CfgRd0', 'CfgWr0', 'CfgRd1', 'CfgWr1', 'MRd', 'MWr', 'Cpl', 'CplD', 'Msg', 'MSG',
  'INT', 'MSI', 'MSI-X', 'PM', 'PM_PME', 'ERR_COR', 'ERR_NONFATAL', 'ERR_FATAL', 'ENUM',
  'TR', 'TC', 'INV', 'INVC', 'PRQ', 'PRG',
]);
const DL_TYPES = new Set([
  'Ack', 'ACK', 'NAK', 'InitFC1', 'InitFC2', 'UpdateFC', 'FLIT', 'FEC', 'RETRY', 'DLLP',
]);
const PHY_TYPES = new Set([
  'TS1', 'TS2', 'SKP', 'EIOS', 'EI', 'FTS', 'LOOPBACK', 'REFCLK', 'PLL', 'CDR', 'EQ',
  'COM', 'BERT', 'BERTERR', 'PATTERN', 'DETECT', 'SPEED', 'MODE', 'HOTRESET', 'LTSSM', 'PHY',
]);

const PHASE_PALETTE = ['#38bdf8', '#22d3ee', '#a78bfa', '#f59e0b', '#34d399', '#f472b6', '#fb923c', '#60a5fa'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** 文本宽度估算：CJK / 全角标点 / 箭头按字号计宽，西文按 0.58 倍字号，避免标签溢出底框。 */
function textWidth(s, size = 9) {
  return [...String(s ?? '')].reduce(
    (n, c) => n + (/[\u3000-\u9fff\uff00-\uffef\u2190-\u21ff\u00b7]/.test(c) ? size : size * 0.58),
    0,
  );
}

function labelOf(ev) {
  const p = ev.packet;
  if (p) {
    if (p.kind === 'TLP') {
      const bits = [p.name];
      if (p.address !== undefined) bits.push(`0x${p.address.toString(16).toUpperCase()}`);
      if (p.length) bits.push(`${p.length}DW`);
      if (p.tag !== undefined) bits.push(`T${p.tag}`);
      if (p.byteCount !== undefined) bits.push(`${p.byteCount}B`);
      if (p.messageCode !== undefined) bits.push(`0x${p.messageCode.toString(16).toUpperCase()}`);
      return bits.join(' ');
    }
    if (p.kind === 'FLIT') return `FLIT #${p.seq} · ${p.packed.length} TLP`;
    if (p.kind === 'DLLP') return p.name + (p.code !== undefined ? ` 0x${p.code.toString(16).toUpperCase()}` : '');
    if (p.name === 'TS1' || p.name === 'TS2') return `${p.name} ${p.controlText || ''}`.trim();
  }
  return ev.summary || ev.type;
}

function flowClass(ev) {
  if (DATA_TYPES.has(ev.type)) return 'data';
  if (CONTROL_TYPES.has(ev.type)) return 'control';
  return 'status';
}

function toneOf(ev) {
  if (ev.type === 'Cpl' || ev.type === 'CplD') return '#34d399';
  if (ev.type === 'FLIT') return '#a78bfa';
  if (ev.type === 'INT') return '#f43f5e';
  if (ev.type === 'PM' || ev.type === 'PM_PME') return '#db2777';
  if (ev.type === 'ERR_COR' || ev.type === 'ERR_NONFATAL' || ev.type === 'ERR_FATAL' || ev.type === 'ERROR') return '#f87171';
  if (flowClass(ev) === 'data') return '#38bdf8';
  if (flowClass(ev) === 'control') return '#fbbf24';
  return '#94a3b8';
}

function dashOf(ev) {
  const cls = flowClass(ev);
  if (cls === 'control') return '6 4';
  if (cls === 'status') return '2 3';
  return 'none';
}

/** 事件所属协议层次：优先采用事件自带的 layer，缺失时按类型推断。 */
function layerOf(ev) {
  if (ev.layer === 'TL') return 'TL';
  if (ev.layer === 'DLL' || ev.layer === 'FLIT') return 'DL';
  if (ev.layer === 'PHY') return 'PHY';
  if (ev.layer === 'STATE') return 'STATE';
  if (TL_TYPES.has(ev.type)) return 'TL';
  if (DL_TYPES.has(ev.type)) return 'DL';
  if (PHY_TYPES.has(ev.type)) return 'PHY';
  return 'STATE';
}

function isArrow(ev) {
  return ev.dir === 'TX' && ev.side && ev.side !== '-';
}

export class FlowView {
  constructor(el, { onSelect } = {}) {
    this.el = el;
    this.sim = null;
    this.scenarioKey = 'link_training';
    this.onSelect = onSelect || null;
  }

  setSim(sim, scenarioKey) {
    if (this.scenarioKey !== scenarioKey) this.el.scrollTop = 0;
    this.sim = sim;
    this.scenarioKey = scenarioKey;
  }

  buildSteps() {
    const events = this.sim ? this.sim.events : [];
    const tx = events.filter((e) => e.dir === 'TX');
    return events.filter((e) => {
      if (e.dir !== 'RX') return true;
      return !tx.some((t) => t.type === e.type && Math.abs(t.t_ns - e.t_ns) <= 6000);
    });
  }

  render({ currentTime = 0, selectedId = null, follow = false } = {}) {
    if (!this.sim) {
      this.el.innerHTML = '';
      return;
    }
    const steps = this.buildSteps();

    // X 方向固定：组件列与层次子列都按容器宽度计算，不产生横向滚动
    const w = Math.max(460, Math.floor((this.el.clientWidth || DEFAULT_W) - 12));
    const X = {
      RP: Math.round(w * 0.17),
      LINK: Math.round(w * 0.5),
      EP: Math.round(w * 0.83),
    };

    // 只显示当前场景实际用到的层次（例如 PHY 场景只有 PHY 一列）；
    // 尚无事件时改用场景行（RC.TL / RC.DLL / RC.PHY…）推断，保证表头照常渲染。
    const rowLayers = new Set((this.sim.rows || []).map((r) => {
      const kind = String(r.key).split('.').pop();
      return kind === 'DLL' ? 'DL' : kind;
    }));
    const layers = LAYERS.filter((l) => steps.some((ev) => layerOf(ev) === l)
      || (!steps.length && rowLayers.has(l)));
    const gap = layers.length >= 3 ? 52 : layers.length === 2 ? 64 : 0;
    // 组件列的可视带宽：包住所有层子列，形成清晰的组件边界
    const laneHalf = layers.length ? ((layers.length - 1) / 2) * gap + 20 : 18;
    // Link 是通道本身，不区分 TL / DL，固定为窄列
    const linkHalf = 24;
    const bandHalf = (base) => (base === X.LINK ? linkHalf : laneHalf);
    // 层次子列按物理位置镜像：RP 的 PHY 靠近 Link（最右），EP 的 PHY 也靠近 Link（最左），
    // 即 EP 侧自左向右为 PHY / DL / TL，RP 侧为 TL / DL / PHY。
    const layersFor = (base) => (base === X.EP ? layers.slice().reverse() : layers);
    const subX = (base, layer) => {
      const list = layersFor(base);
      const idx = list.indexOf(layer);
      if (idx < 0) return base;
      return base + (idx - (list.length - 1) / 2) * gap;
    };

    // ---- 固定表头：组件 + 层次子列（先于事件渲染，避免无事件时整块空白） ----
    let head = `<svg class="flow-svg" width="${w}" height="${HEAD_H}" viewBox="0 0 ${w} ${HEAD_H}" xmlns="http://www.w3.org/2000/svg">`;
    [X.RP, X.EP].forEach((base) => {
      const half = bandHalf(base);
      head += `<rect x="${base - half}" y="3" width="${half * 2}" height="${HEAD_H - 8}" rx="8"
        fill="#12233c" stroke="#2b4162" stroke-opacity="0.95"/>`;
    });
    // Link 表头：独立的“通道”胶囊，顶部青色高亮条 + 双向箭头，与两端组件区分
    head += `<rect class="flow-link-head" x="${X.LINK - 24}" y="3" width="48" height="${HEAD_H - 8}" rx="12"
      fill="#0d2438" stroke="#2a6f8f" stroke-opacity="0.95"/>`;
    head += `<rect x="${X.LINK - 16}" y="6" width="32" height="2.5" rx="1.25"
      fill="#38bdf8" fill-opacity="0.8"/>`;
    head += `<text class="flow-component" x="${X.RP}" y="20" text-anchor="middle">RP / RC</text>`;
    head += `<text class="flow-component-sub" x="${X.RP}" y="34" text-anchor="middle">Root Port</text>`;
    head += `<text class="flow-component link" x="${X.LINK}" y="21" text-anchor="middle">Link</text>`;
    head += `<text class="flow-link-glyph" x="${X.LINK}" y="37" text-anchor="middle">⇄</text>`;
    head += `<text class="flow-component-sub" x="${X.LINK}" y="55" text-anchor="middle">通道</text>`;
    head += `<text class="flow-component" x="${X.EP}" y="20" text-anchor="middle">EP</text>`;
    head += `<text class="flow-component-sub" x="${X.EP}" y="34" text-anchor="middle">Endpoint</text>`;
    layers.forEach((l) => {
      const meta = LAYER_META[l];
      [X.RP, X.EP].forEach((base) => {
        const x = subX(base, l);
        head += `<rect x="${x - 20}" y="43" width="40" height="16" rx="8"
          fill="${meta.color}" fill-opacity="0.14" stroke="${meta.color}" stroke-opacity="0.6"/>`;
        head += `<text class="flow-layer" x="${x}" y="55" text-anchor="middle" fill="${meta.color}">${meta.title}</text>`;
      });
    });
    head += '</svg>';

    // 时间轴尚未推进、还没有事件：保留表头与说明，提示如何开始
    if (!steps.length) {
      const chips = layers
        .map((l) => `<span class="flow-key ${l.toLowerCase()}">${l} · ${LAYER_META[l].detail}</span>`)
        .join('');
      this.el.innerHTML = `<div class="flow-sticky">
        <div class="flow-head">${head}</div>
        <div class="flow-status"><span class="flow-now-dot idle"></span>待开始
          <span class="flow-now-step">尚未产生事件</span></div>
      </div>
      <div class="flow-legend">${chips}<span class="flow-key phase">虚线框 · 阶段</span></div>
      <p class="flow-hint">点击「运行」或「单步」后，事件会按阶段出现在这里。</p>
      <p class="flow-def">${esc(FLOW_DEF[this.scenarioKey] || '')}</p>
      <div class="flow-canvas"><p class="empty">等待事件…</p></div>`;
      return;
    }

    // Y 轴位置：阶段切换处额外留白，保证虚线框标题不与上一阶段的事件重叠
    const ys = [];
    let cy = TOP;
    steps.forEach((ev, i) => {
      if (i > 0 && (ev.phase || 'pre') !== (steps[i - 1].phase || 'pre')) cy += 26;
      ys.push(cy);
      cy += ROW;
    });
    const yOf = (i) => ys[i];
    const height = ys[ys.length - 1] + 60;

    // 阶段分组
    const groups = [];
    steps.forEach((ev, i) => {
      const key = ev.phase || 'pre';
      if (!groups.length || groups[groups.length - 1].key !== key) {
        groups.push({ key, items: [] });
      }
      groups[groups.length - 1].items.push({ ev, i });
    });

    const phaseMap = new Map((this.sim.phases || []).map((p) => [p.key, p]));
    let currentIdx = -1;
    steps.forEach((ev, i) => {
      if (ev.t_ns <= currentTime + 1) currentIdx = i;
    });
    // 当前事件所属的阶段分组（用于高亮当前阶段）
    const activeGi = currentIdx >= 0
      ? groups.findIndex((g) => currentIdx >= g.items[0].i && currentIdx <= g.items[g.items.length - 1].i)
      : -1;

    // ---- 正文 ----
    let svg = `<svg class="flow-svg" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}" xmlns="http://www.w3.org/2000/svg">`;

    // 组件列背景带：让 RP / EP 的边界清晰（Link 单独画成通道）
    [X.RP, X.EP].forEach((base) => {
      const half = bandHalf(base);
      svg += `<rect class="flow-band" x="${base - half}" y="2" width="${half * 2}" height="${height - 6}" rx="8"
        fill="#1e3a5f" fill-opacity="0.16" stroke="#2b4162" stroke-opacity="0.9"/>`;
    });

    // Link 通道：细长胶囊 + 中间渐亮 + 两侧导轨，表达“链路本身”而非组件盒子
    const linkTop = 4;
    const linkBot = height - 8;
    svg += `<defs>
      <linearGradient id="flowLinkGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#0a1a2b"/>
        <stop offset="0.5" stop-color="#173d57"/>
        <stop offset="1" stop-color="#0a1a2b"/>
      </linearGradient>
    </defs>`;
    svg += `<rect class="flow-link-channel" x="${X.LINK - 13}" y="${linkTop}" width="26" height="${linkBot - linkTop}" rx="13"
      fill="url(#flowLinkGrad)" stroke="#2a5878" stroke-opacity="0.95"/>`;
    svg += `<line x1="${X.LINK - 7}" y1="${linkTop + 12}" x2="${X.LINK - 7}" y2="${linkBot - 12}"
      class="flow-link-rail"/>`;
    svg += `<line x1="${X.LINK + 7}" y1="${linkTop + 12}" x2="${X.LINK + 7}" y2="${linkBot - 12}"
      class="flow-link-rail"/>`;
    svg += `<line x1="${X.LINK}" y1="${linkTop + 12}" x2="${X.LINK}" y2="${linkBot - 12}"
      stroke="#7dd3fc" stroke-opacity="0.12" stroke-dasharray="1 7"/>`;

    // 层次子列参考线（Link 不区分 TL / DL）
    if (layers.length) {
      layers.forEach((l) => {
        const color = LAYER_META[l].color;
        [X.RP, X.EP].forEach((base) => {
          const x = subX(base, l);
          svg += `<line x1="${x}" y1="4" x2="${x}" y2="${height - 8}" stroke="${color}" stroke-opacity="0.26"
            stroke-width="1.1" stroke-dasharray="3 5"/>`;
        });
      });
    } else {
      svg += `<line x1="${X.RP}" y1="4" x2="${X.RP}" y2="${height - 8}" stroke="#22314c" stroke-dasharray="4 4"/>`;
      svg += `<line x1="${X.EP}" y1="4" x2="${X.EP}" y2="${height - 8}" stroke="#22314c" stroke-dasharray="4 4"/>`;
    }

    // 阶段虚线框
    groups.forEach((g, gi) => {
      const first = g.items[0].i;
      const last = g.items[g.items.length - 1].i;
      const y0 = Math.max(2, yOf(first) - 42);
      const y1 = yOf(last) + 28;
      const color = PHASE_PALETTE[gi % PHASE_PALETTE.length];
      const phase = phaseMap.get(g.key) || { label: g.key, detail: '' };
      const active = gi === activeGi;
      svg += `<g class="flow-phase${active ? ' flow-phase-active' : ''}">
        <rect x="6" y="${y0}" width="${w - 12}" height="${y1 - y0}" rx="8"
          fill="${color}" fill-opacity="${active ? 0.06 : 0.035}" stroke="${color}"
          stroke-opacity="${active ? 0.85 : 0.5}" stroke-width="${active ? 1.3 : 1}" stroke-dasharray="6 4"/>
        <text class="flow-phase-title" x="18" y="${y0 + 15}">P${String(gi + 1).padStart(2, '0')} · ${esc(phase.label)}</text>
        <text class="flow-phase-detail" x="18" y="${y0 + 28}">${esc(truncate(phase.detail || '', 92))}</text>
      </g>`;
    });

    // 事件
    steps.forEach((ev, i) => {
      const y = yOf(i);
      const tone = toneOf(ev);
      const layer = layerOf(ev);
      const isCurrent = i === currentIdx;
      const opacity = ev.t_ns <= currentTime + 1 ? 1 : 0.2;
      const selected = ev.id === selectedId;
      const tag = layer === 'STATE' ? 'S' : layer;
      const arrowTag = ev.side === 'EP' ? 'EP→RC' : 'RC→EP';
      const arrowText = `${tag} · ${arrowTag} · ${truncate(labelOf(ev), 30)}`;

      svg += `<g class="flow-step${isCurrent ? ' flow-current' : ''}" data-id="${ev.id}" opacity="${opacity}" role="button" tabindex="0"
        aria-label="${esc(ev.summary || labelOf(ev))}">`;
      svg += `<title>${esc(ev.summary || labelOf(ev))}</title>`;

      if (isArrow(ev)) {
        const fromBase = ev.side === 'EP' ? X.EP : X.RP;
        const toBase = ev.side === 'EP' ? X.RP : X.EP;
        const fromX = subX(fromBase, layer);
        const toX = subX(toBase, layer);
        const dir = toX > fromX ? 1 : -1;
        svg += `<line x1="${fromX}" y1="${y}" x2="${toX}" y2="${y}" stroke="${tone}" stroke-width="1.3"
          stroke-dasharray="${dashOf(ev)}" opacity="0.9"/>`;
        svg += `<polygon points="${toX},${y} ${toX - dir * 7},${y - 4} ${toX - dir * 7},${y + 4}" fill="${tone}"/>`;
        svg += `<circle cx="${fromX}" cy="${y}" r="2.6" fill="${tone}"/>`;

        const span = Math.abs(toX - fromX) - 12;
        const bw = Math.min(Math.min(330, w * 0.66), Math.max(120, textWidth(arrowText) + 22), span);
        const bx = (fromX + toX) / 2 - bw / 2;
        if (isCurrent) {
          svg += `<rect class="flow-current-box" x="${bx - 4}" y="${y - 14}" width="${bw + 8}" height="28" rx="7"
            fill="${tone}" fill-opacity="0.07" stroke="${tone}"/>`;
        }
        svg += `<rect x="${bx}" y="${y - 10}" width="${bw}" height="20" rx="4"
          fill="#0a1729" stroke="${tone}" stroke-opacity="${selected ? 1 : 0.55}" stroke-width="${selected ? 1.6 : 1}"/>`;
        svg += `<text class="flow-label" x="${bx + bw / 2}" y="${y + 4}" text-anchor="middle">${esc(arrowText)}</text>`;
      } else if (ev.side && ev.side !== '-') {
        // 本端事件（如 REF CLK / PLL / CDR / EQ）：贴在所属组件 + 层次的子列上
        const cx = subX(ev.side === 'EP' ? X.EP : X.RP, layer);
        const localText = `${tag} · ${truncate(labelOf(ev), 30)}`;
        const bw = Math.min(Math.round(w * 0.38), Math.max(126, textWidth(localText) + 22));
        const bx = Math.min(Math.max(6, cx - bw / 2), w - 6 - bw);
        if (isCurrent) {
          svg += `<rect class="flow-current-box" x="${bx - 4}" y="${y - 14}" width="${bw + 8}" height="28" rx="10"
            fill="${tone}" fill-opacity="0.07" stroke="${tone}"/>`;
        }
        svg += `<rect x="${bx}" y="${y - 10}" width="${bw}" height="20" rx="10"
          fill="#0a1729" stroke="${tone}" stroke-opacity="${selected ? 1 : 0.6}" stroke-width="${selected ? 1.6 : 1}"/>`;
        svg += `<circle cx="${bx + 9}" cy="${y}" r="2" fill="${tone}"/>`;
        svg += `<text class="flow-label" x="${bx + bw / 2 + 4}" y="${y + 4}" text-anchor="middle">${esc(localText)}</text>`;
      } else {
        const note = truncate(ev.summary || labelOf(ev), 64);
        const noteText = `S · ${note}`;
        const bw = Math.min(w - 40, Math.max(200, textWidth(noteText, 10) + 26));
        const bx = (w - bw) / 2;
        if (isCurrent) {
          svg += `<rect class="flow-current-box" x="${bx - 4}" y="${y - 15}" width="${bw + 8}" height="30" rx="7"
            fill="${tone}" fill-opacity="0.07" stroke="${tone}"/>`;
        }
        svg += `<rect x="${bx}" y="${y - 11}" width="${bw}" height="22" rx="5"
          fill="#0a1729" stroke="${tone}" stroke-opacity="${selected ? 1 : 0.4}" stroke-dasharray="4 3"/>`;
        svg += `<circle cx="${X.RP}" cy="${y}" r="2.5" fill="${tone}" opacity="0.7"/>`;
        svg += `<circle cx="${X.EP}" cy="${y}" r="2.5" fill="${tone}" opacity="0.7"/>`;
        svg += `<text class="flow-note" x="${w / 2}" y="${y + 4}" text-anchor="middle">${esc(noteText)}</text>`;
      }
      svg += '</g>';
    });

    // 当前播放头
    if (currentIdx >= 0) {
      const y = yOf(currentIdx);
      svg += `<line x1="8" y1="${y}" x2="${w - 8}" y2="${y}" stroke="#38bdf8" stroke-opacity="0.5" stroke-dasharray="3 4"/>`;
      svg += `<circle cx="${X.LINK}" cy="${y}" r="3" fill="#38bdf8"/>`;
      svg += `<text class="flow-phase-detail" x="${w - 12}" y="${y - 6}" text-anchor="end">t = ${(steps[currentIdx].t_ns / 1000).toFixed(1)} µs</text>`;
    }

    svg += '</svg>';

    const def = FLOW_DEF[this.scenarioKey] || '';
    const chips = layers
      .map((l) => `<span class="flow-key ${l.toLowerCase()}">${l} · ${LAYER_META[l].detail}</span>`)
      .join('');
    // 固定分区顶部常驻状态：当前阶段 / 步数 / 时间
    const curPhase = activeGi >= 0
      ? (phaseMap.get(groups[activeGi].key) || { label: groups[activeGi].key })
      : null;
    const status = currentIdx >= 0
      ? `<span class="flow-now-dot"></span>当前
         <b>P${String(activeGi + 1).padStart(2, '0')} · ${esc(curPhase ? curPhase.label : '未分阶段')}</b>
         <span class="flow-now-step">第 ${currentIdx + 1}/${steps.length} 步</span>
         <span class="flow-now-time">t = ${(steps[currentIdx].t_ns / 1000).toFixed(1)} µs</span>`
      : `<span class="flow-now-dot idle"></span>待开始 <span class="flow-now-step">共 ${steps.length} 步</span>`;

    this.el.innerHTML = `<div class="flow-sticky">
      <div class="flow-head">${head}</div>
      <div class="flow-status">${status}</div>
    </div>
    <div class="flow-legend">
      ${chips}
      <span class="flow-key phase">虚线框 · 阶段</span>
    </div>
    <p class="flow-hint">箭头只在同层子列之间连接（TL→TL、DL→DL、PHY→PHY）；Link 为通道本身，不区分 TL / DL。点击任一步骤可查看事件详情。</p>
    <p class="flow-def">${esc(def)}</p>
    <div class="flow-canvas">${svg}</div>`;

    this.el.querySelectorAll('.flow-step').forEach((g) => {
      const activate = () => {
        if (this.onSelect) this.onSelect(Number(g.dataset.id));
      };
      g.addEventListener('click', activate);
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });
    });

    if (follow && currentIdx >= 0) {
      const node = this.el.querySelector(`.flow-step[data-id="${steps[currentIdx].id}"]`);
      if (node) {
        const box = node.getBoundingClientRect();
        const host = this.el.getBoundingClientRect();
        if (box.top < host.top + 120 || box.bottom > host.bottom - 40) {
          this.el.scrollTop = Math.max(0, this.el.scrollTop + (box.top - host.top) - 170);
        }
      }
    } else if (selectedId != null) {
      // 从日志 / 时序图选中事件时，若该步骤不在可视区则滚动过来
      const node = this.el.querySelector(`.flow-step[data-id="${selectedId}"]`);
      if (node) {
        const box = node.getBoundingClientRect();
        const host = this.el.getBoundingClientRect();
        if (box.bottom < host.top + 100 || box.top > host.bottom - 10) {
          this.el.scrollTop = Math.max(0, this.el.scrollTop + (box.top - host.top) - 150);
        }
      }
    }
  }
}
