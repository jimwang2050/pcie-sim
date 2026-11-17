/**
 * 分层时序图：时间轴按事件时间定位。
 * 交互：悬停显示事件速览卡片，单击打开事件详情弹窗。
 */
import { ratesText } from '../core/packet.js';
import { bdfText } from '../core/tlp.js';

const DEFAULT_ROWS = [
  { key: 'STATE', label: 'LTSSM 状态' },
  { key: 'RC.PHY', label: 'RC · PHY' },
  { key: 'EP.PHY', label: 'EP · PHY' },
];

const PHASE_COLOR = {
  detect: '#0ea5e9',
  polling: '#0284c7',
  config: '#2563eb',
  recovery: '#7c3aed',
  l0: '#059669',
  link: '#0ea5e9',
  l0s: '#0891b2',
  l1: '#7c3aed',
  l2: '#4338ca',
  pm: '#db2777',
  hotplug: '#f97316',
  enum: '#0369a1',
  refclk: '#f59e0b',
  cdr: '#06b6d4',
  speed: '#7c3aed',
  eq: '#a78bfa',
  loopback: '#b45309',
  lpbk_int: '#f59e0b',
  lpbk_ext: '#fb923c',
  bert: '#0e7490',
  d0: '#db2777',
  d1: '#a21caf',
  d3: '#7c3aed',
  wake: '#f472b6',
  d3cold: '#334155',
  reset: '#f59e0b',
  flit: '#a78bfa',
  fec: '#f59e0b',
  retry: '#f87171',
  dpc: '#f43f5e',
  ats: '#0ea5e9',
  pri: '#a78bfa',
};

const TYPE_COLOR = {
  TS1: '#38bdf8',
  TS2: '#22d3ee',
  SKP: '#94a3b8',
  EIOS: '#f59e0b',
  EI: '#475569',
  DETECT: '#fbbf24',
  SPEED: '#a78bfa',
  MODE: '#f472b6',
  FTS: '#2dd4bf',
  FLIT: '#a78bfa',
  DLLP: '#22d3ee',
  MSG: '#fb923c',
  ACK: '#94a3b8',
  CfgRd0: '#38bdf8',
  CfgWr0: '#38bdf8',
  CfgRd1: '#38bdf8',
  CfgWr1: '#38bdf8',
  MRd: '#38bdf8',
  MWr: '#38bdf8',
  Cpl: '#34d399',
  CplD: '#34d399',
  ENUM: '#34d399',
  REFCLK: '#fbbf24',
  PLL: '#f59e0b',
  CDR: '#22d3ee',
  DPC: '#f43f5e',
  ATS: '#0ea5e9',
  ATC: '#38bdf8',
  TR: '#0ea5e9',
  TC: '#34d399',
  INV: '#f59e0b',
  INVC: '#fbbf24',
  PRQ: '#a78bfa',
  PRG: '#c4b5fd',
  PRI: '#a78bfa',
  EQ: '#a78bfa',
  COM: '#34d399',
  LOOPBACK: '#f59e0b',
  BERT: '#22d3ee',
  BERTERR: '#f87171',
  PATTERN: '#06b6d4',
  InitFC1: '#22d3ee',
  InitFC2: '#06b6d4',
  UpdateFC: '#94a3b8',
  DONE: '#34d399',
  MSI: '#22d3ee',
  'MSI-X': '#38bdf8',
  INT: '#f43f5e',
  ERROR: '#f87171',
  ERR_COR: '#fbbf24',
  ERR_NONFATAL: '#fb923c',
  ERR_FATAL: '#f87171',
  HOTRESET: '#f59e0b',
  PM: '#db2777',
  PM_PME: '#f472b6',
  FEC: '#fbbf24',
  RETRY: '#f87171',
  NAK: '#fb923c',
  LTSSM: '#f59e0b',
};

const STATE_SHORT = {
  Detect: 'Detect',
  Polling: 'Polling',
  Configuration: 'Config',
  Recovery: 'Recovery',
  L0: 'L0',
  L0s: 'L0s',
  L1: 'L1',
  L2: 'L2',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function us(v) {
  return (v / 1000).toFixed(v < 10000 ? 1 : 0);
}

export class Timeline {
  constructor(root, { onSelect, onSelectRow } = {}) {
    this.root = root;
    this.sim = null;
    this.selectedId = null;
    this.tip = null;
    this.tipId = null;
    this.autoTip = null;
    this.autoId = null;
    this.autoContentId = null;
    this.autoEnabled = false;
    this.autoDismissed = false;
    this.onSelect = onSelect || (() => {});
    this.onSelectRow = onSelectRow || (() => {});

    root.addEventListener('click', (e) => {
      const rowNode = e.target.closest('[data-row]');
      if (rowNode) {
        this.hideTip();
        this.onSelectRow(rowNode.dataset.row);
        return;
      }
      const node = e.target.closest('[data-id]');
      if (!node) return;
      this.hideTip();
      this.onSelect(Number(node.dataset.id));
    });

    root.addEventListener('pointermove', (e) => {
      const node = e.target.closest('[data-id]');
      if (!node) {
        this.hideTip();
        return;
      }
      this.showTip(Number(node.dataset.id), e.clientX, e.clientY);
    });
    root.addEventListener('pointerleave', () => this.hideTip());
    root.addEventListener('scroll', () => {
      this.hideTip();
      this.positionAutoTip();
    }, true);
    window.addEventListener('scroll', () => this.positionAutoTip(), true);
    window.addEventListener('resize', () => this.positionAutoTip());
  }

  setSim(sim) {
    this.sim = sim;
    this.selectedId = null;
    // 新场景 / 复位后自动浮窗重新出现
    this.autoDismissed = false;
    this.hideTip();
  }

  ensureTip() {
    if (!this.tip) {
      this.tip = document.createElement('div');
      this.tip.className = 'evt-tip';
      this.tip.hidden = true;
      document.body.appendChild(this.tip);
    }
    return this.tip;
  }

  hideTip() {
    if (this.tip) this.tip.hidden = true;
    this.tipId = null;
    if (this.autoEnabled) this.positionAutoTip();
  }

  showTip(id, x, y) {
    if (!this.sim) return;
    const ev = this.sim.events.find((e) => e.id === id);
    if (!ev) return;
    const tip = this.ensureTip();
    if (this.autoTip) this.autoTip.hidden = true;

    if (this.tipId !== id) {
      this.tipId = id;
      tip.innerHTML = this.tipHtml(ev, false);
    }

    tip.hidden = false;
    const rect = tip.getBoundingClientRect();
    const left = Math.min(x + 16, window.innerWidth - rect.width - 10);
    const top = Math.min(y + 16, window.innerHeight - rect.height - 10);
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }

  /** 悬停卡片与自动浮窗共用的内容。 */
  tipHtml(ev, auto) {
    const type = ev.type.toLowerCase();
    let body = '';
    if (ev.packet) {
      const p = ev.packet;
      if (p.kind === 'FLIT') {
        body = `<div class="tip-grid">
          <span>Flit 序号</span><b>#${p.seq}</b>
          <span>大小</span><b>256 B</b>
          <span>负载</span><b>${esc(p.payloadName)}</b>
        </div>`;
      } else if (p.kind === 'DLLP' || p.kind === 'MSG') {
        body = `<div class="tip-grid">
          <span>类型</span><b>${esc(p.name)}</b>
          <span>类型码</span><b>0x${p.code.toString(16).toUpperCase()}</b>
        </div>`;
      } else if (p.kind === 'TLP') {
        const rows = [
          ['类型', p.name],
          ['长度', `${p.length} DW`],
        ];
        if (p.tag !== undefined) rows.push(['Tag', `0x${p.tag.toString(16).toUpperCase()}`]);
        if (p.address !== undefined) rows.push(['地址', `0x${p.address.toString(16).toUpperCase()}`]);
        if (p.bdf !== undefined) rows.push(['BDF', bdfText(p.bdf)]);
        if (p.byteCount !== undefined) rows.push(['Byte Count', `${p.byteCount} B`]);
        if (p.lowerAddress !== undefined) rows.push(['Lower Addr', `0x${p.lowerAddress.toString(16).toUpperCase()}`]);
        body = `<div class="tip-grid">${rows.map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('')}</div>`;
      } else {
        const lane0 = p.lanes && p.lanes[0];
        body = `<div class="tip-grid">
          <span>Link</span><b>${p.linkPAD ? 'PAD' : p.link}</b>
          <span>Lane</span><b>${lane0 && lane0.number !== null ? lane0.number : 'PAD'}</b>
          <span>N_FTS</span><b>${p.nFts}</b>
          <span>支持速率</span><b>${esc(ratesText(p.rates))}</b>
          ${p.flitMode ? '<span>Flit Mode</span><b>1</b>' : ''}
          ${p.speedChange ? '<span>Speed Chg</span><b>1</b>' : ''}
        </div>`;
      }
    } else if (ev.state) {
      body = `<div class="tip-grid"><span>LTSSM</span><b>${esc(ev.state)}</b></div>`;
    }
    const hint = auto
      ? (ev.row === 'STATE' ? '当前 LTSSM 状态 · 单击查看详情' : '当前事件 · 单击查看详情')
      : '单击查看完整字段与 Lane 矩阵';
    return `<div class="tip-head">
        <span class="badge b-${type}">${esc(ev.type)}</span>
        <span class="tip-time">${us(ev.t_ns)} µs</span>
        ${auto ? '<button class="tip-close" type="button" aria-label="关闭自动浮窗">×</button>' : ''}
      </div>
      <div class="tip-sum">${esc(ev.summary)}</div>
      ${body}
      <p class="tip-hint">${hint}</p>`;
  }

  ensureAutoTip() {
    if (!this.autoTip) {
      this.autoTip = document.createElement('div');
      this.autoTip.className = 'evt-auto';
      this.autoTip.hidden = true;
      this.autoTip.addEventListener('click', (e) => {
        // × 关闭：本次场景内不再自动弹出，复位或换场景后恢复
        if (e.target.closest('.tip-close')) {
          e.stopPropagation();
          this.autoDismissed = true;
          this.autoTip.hidden = true;
          return;
        }
        if (this.autoId !== null) this.onSelect(this.autoId);
      });
      document.body.appendChild(this.autoTip);
    }
    return this.autoTip;
  }

  /** 自动浮窗：单步时显示当前目标事件，锚定在时间轴方框上方。 */
  renderAutoTip(id, show) {
    const tip = this.ensureAutoTip();
    if (!show || id === null || !this.sim || this.autoDismissed) {
      tip.hidden = true;
      this.autoId = null;
      return;
    }
    const ev = this.sim.events.find((e) => e.id === id);
    if (!ev) {
      tip.hidden = true;
      this.autoId = null;
      return;
    }
    this.autoId = id;
    if (this.autoContentId !== id) {
      tip.innerHTML = this.tipHtml(ev, true);
      this.autoContentId = id;
    }
    tip.hidden = false;
    this.positionAutoTip();
  }

  positionAutoTip() {
    if (!this.autoEnabled || !this.autoTip || this.autoId === null) return;
    const node = this.root.querySelector(`[data-id="${this.autoId}"]`);
    const scroller = this.root.querySelector('.tl');
    if (!node || !scroller) {
      this.autoTip.hidden = true;
      return;
    }
    const a = node.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    if (a.right < s.left + 2 || a.left > s.right - 2) {
      this.autoTip.hidden = true;
      return;
    }
    this.autoTip.hidden = false;
    const t = this.autoTip.getBoundingClientRect();
    let left = a.left + a.width / 2 - t.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
    let top = a.top - t.height - 12;
    let placement = 'above';
    if (top < 8) {
      top = a.bottom + 12;
      placement = 'below';
    }
    this.autoTip.dataset.placement = placement;
    this.autoTip.style.left = `${left}px`;
    this.autoTip.style.top = `${top}px`;
    const arrowX = Math.max(12, Math.min(t.width - 12, a.left + a.width / 2 - left));
    this.autoTip.style.setProperty('--arrow-x', `${arrowX}px`);
  }

  render(selectedId = null, follow = true, selectedRow = null, showAuto = false) {
    if (!this.sim) return;
    this.selectedId = selectedId;
    this.hideTip();
    const sim = this.sim;
    const rows = sim.rows && sim.rows.length ? sim.rows : DEFAULT_ROWS;
    const duration = Math.max(sim.durationNs, 1);
    const pxPerUs = 2.6;
    const W = Math.max(900, Math.round((duration / 1000) * pxPerUs));
    const rowH = 46;
    const top = 48;
    const H = top + rows.length * rowH + 16;
    const padX = 14;
    const innerW = W - padX * 2;
    const xOf = (t) => padX + (Math.max(0, Math.min(t, duration)) / duration) * innerW;

    const parts = [];

    // 阶段色带
    for (const ph of sim.phases) {
      const end = ph.end_ns ?? duration;
      const x1 = xOf(ph.start_ns);
      const x2 = Math.max(x1 + 2, xOf(end));
      parts.push(`<rect x="${x1}" y="4" width="${x2 - x1}" height="22" rx="4" fill="${PHASE_COLOR[ph.kind] || '#334155'}"/>`);
      if (x2 - x1 > 64) {
        parts.push(`<text x="${x1 + 7}" y="19" class="tl-phase-t">${esc(ph.label)}</text>`);
      }
    }

    // 时间刻度
    const TICKS = 8;
    for (let i = 0; i <= TICKS; i += 1) {
      const t = (duration * i) / TICKS;
      const x = xOf(t);
      parts.push(`<line x1="${x}" y1="30" x2="${x}" y2="${H - 8}" class="tl-grid"/>`);
      parts.push(`<text x="${x}" y="43" class="tl-tick">${us(t)} µs</text>`);
    }

    // 行背景
    rows.forEach((row, idx) => {
      const y = top + idx * rowH;
      parts.push(`<rect x="0" y="${y}" width="${W}" height="${rowH}" class="${idx % 2 ? 'tl-row-b' : 'tl-row-a'}"/>`);
      parts.push(`<line x1="0" y1="${y + rowH}" x2="${W}" y2="${y + rowH}" class="tl-sep"/>`);
    });

    // 事件（按行分组，便于计算右侧标签的可用空间）
    const byRow = new Map(rows.map((r) => [r.key, []]));
    for (const ev of sim.events) {
      const list = byRow.get(ev.row);
      if (list) list.push(ev);
    }

    rows.forEach((row, idx) => {
      const list = byRow.get(row.key);
      const y = top + idx * rowH;
      const cy = y + rowH / 2;
      list.forEach((ev, i) => {
        const x = xOf(ev.t_ns);
        const nextX = i + 1 < list.length ? xOf(list[i + 1].t_ns) : W - padX;
        const gap = nextX - x;
        const color = TYPE_COLOR[ev.type] || '#64748b';
        const sel = ev.id === selectedId;

        if (ev.layer === 'STATE') {
          const short = STATE_SHORT[(ev.state || '').split('.')[0]] || '';
          parts.push(`<g data-id="${ev.id}" class="tl-ev">
            <path d="M ${x} ${cy - 7} L ${x + 7} ${cy} L ${x} ${cy + 7} L ${x - 7} ${cy} Z"
                  fill="${color}" stroke="${sel ? '#fff' : 'none'}" stroke-width="1.6"/>
            ${short && gap > 46 ? `<text x="${x + 11}" y="${cy + 3}" class="tl-ev-l">${esc(short)}</text>` : ''}
          </g>`);
        } else {
          const minW = Math.max(34, 14 + ev.type.length * 5.6);
          const w = Math.max(minW, (ev.dur_ns / duration) * innerW);
          const idle = ev.status === 'idle';
          const inside = w >= 30;
          // RX 用虚线框 + 低填充，与实心实线的 TX 区分
          const rx = ev.dir === 'RX';
          const stroke = sel ? '#fff' : (rx ? color : 'rgba(255,255,255,0.22)');
          parts.push(`<g data-id="${ev.id}" class="tl-ev" opacity="${idle ? 0.7 : 1}">
            <rect class="tl-box${rx ? ' rx' : ''}" x="${x}" y="${cy - 12}" width="${w}" height="24" rx="5"
                  fill="${color}" fill-opacity="${rx ? 0.2 : 1}" stroke="${stroke}"
                  stroke-width="${sel ? 1.8 : (rx ? 1.3 : 1)}"${rx ? ' stroke-dasharray="4 3"' : ''}/>
            ${inside ? `<text x="${x + 5}" y="${cy + 4}" class="tl-ev-t${rx ? ' rx' : ''}">${esc(ev.type)}</text>` : ''}
          </g>`);
          if (!inside && gap > w + 30) {
            parts.push(`<text x="${x + w + 5}" y="${cy + 4}" class="tl-ev-l${rx ? ' rx' : ''}">${esc(ev.type)}</text>`);
          }
        }
      });
    });

    // 播放头
    const px = xOf(sim.clock);
    parts.push(`<line x1="${px}" y1="28" x2="${px}" y2="${H - 8}" class="tl-playhead"/>`);
    parts.push(`<path d="M ${px - 4} 28 L ${px + 4} 28 L ${px} 35 Z" fill="#f43f5e"/>`);

    const labels = [
      '<div class="tl-labels">',
      '<div class="tl-label-phase">阶段</div>',
      ...rows.map((r) => `<div class="tl-label-row${selectedRow === r.key ? ' active' : ''}"
        data-row="${r.key}" style="height:${rowH}px" title="只看 ${esc(r.label)}">${esc(r.label)}</div>`),
      '</div>',
    ].join('');

    const scroller = this.root.querySelector('.tl');
    const prevScroll = scroller ? scroller.scrollLeft : 0;

    this.root.innerHTML = `<div class="tl">
      ${labels}
      <div class="tl-scroll">
        <svg class="tl-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
          ${parts.join('')}
        </svg>
      </div>
    </div>`;

    const nextScroller = this.root.querySelector('.tl');
    if (follow && sim.clock > 0) {
      nextScroller.scrollLeft = Math.max(0, px - nextScroller.clientWidth / 2);
    } else if (follow) {
      nextScroller.scrollLeft = 0;
    } else {
      nextScroller.scrollLeft = prevScroll;
    }

    this.autoEnabled = showAuto;
    this.renderAutoTip(selectedId, showAuto);
  }
}
