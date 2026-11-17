/**
 * 拓扑与端口状态卡片：RC 与 EP 上下排布，中间用 TX / RX 两条独立通道表示链路。
 */
import { RATE_BY_GEN } from '../core/packet.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function node(side, port, up) {
  return `<div class="node${up ? ' up' : ''}">
    <div class="node-name">${side}</div>
    <div class="node-role">${side === 'RC' ? '根复合体 / 下游端口' : '端点 / 上游端口'}</div>
    <div class="node-state">${esc(port.state)}</div>
  </div>`;
}

/** TX / RX 两条独立通道，---/--- 的斜杠表示可多条 lane。 */
function busSvg(up) {
  const tx = up ? '#22d3ee' : '#22314c';
  const rx = up ? '#f472b6' : '#22314c';
  const x0 = 15;
  const seg = 13;
  const gap = 5;
  const row = (y, color) => {
    let out = '';
    for (let i = 0; i < 3; i += 1) {
      const x = x0 + i * (seg + gap);
      out += `<line x1="${x}" y1="${y}" x2="${x + seg}" y2="${y}"
        stroke="${color}" stroke-width="2" stroke-linecap="round"/>`;
      if (i < 2) {
        out += `<line x1="${x + seg + 2}" y1="${y + 5}" x2="${x + seg + 5}" y2="${y - 5}"
          stroke="${color}" stroke-width="1.2"/>`;
      }
    }
    return out;
  };
  return `<svg class="topo-bus" viewBox="0 0 70 46" role="img"
    aria-label="TX / RX 独立差分通道，斜杠表示多条 lane">
    <text x="0" y="21" fill="${tx}">TX</text>
    ${row(18, tx)}
    <polygon points="68,18 60,14 60,22" fill="${tx}"/>
    <text x="0" y="40" fill="${rx}">RX</text>
    ${row(36, rx)}
    <polygon points="13,36 21,32 21,40" fill="${rx}"/>
    ${up ? `<circle r="2" fill="${tx}"><animateMotion dur="2.6s" repeatCount="indefinite" path="M15,18 H64"/></circle>
    <circle r="2" fill="${rx}"><animateMotion dur="3.4s" repeatCount="indefinite" path="M64,36 H15"/></circle>` : ''}
  </svg>`;
}

export function renderTopology(el, sim) {
  const link = sim.link;
  const width = link.width;
  const rate = RATE_BY_GEN[link.ports.RC.rateGen] ?? RATE_BY_GEN[1];
  const up = link.linkUp;

  el.innerHTML = `<div class="topo">
    ${node('RC', link.ports.RC, up)}
    <div class="topo-link${up ? ' up' : ''}">
      ${busSvg(up)}
      <div class="topo-meta">Gen${link.targetGen} · x${width}</div>
      <div class="topo-rate">${up ? rate : '2.5 GT/s'}</div>
    </div>
    ${node('EP', link.ports.EP, up)}
  </div>`;
}
