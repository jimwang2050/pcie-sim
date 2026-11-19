/**
 * PHY 典型处理模型视图：TX/RX EQ、CDR 时钟恢复、REF CLK / PLL。
 *
 * 每个模型按“架构 → 逐级运算 → 数学模型 → 动态演示 → 过程状态”组织，
 * 架构图给出信号流与每级的传递函数/当前数值，公式给出底层数学定义，
 * 动态演示用 SMIL 动画展示信号在链路中的处理过程。
 * 数值全部来自 PhyModel.snapshot()，与仿真共用同一简化模型。
 */
import { EQ_PRESETS, RX_EQ_BY_GEN, PHY_CHANNEL_LOSS, cdrText } from '../core/phy.js';
import { GEN_RATE, encodingOf } from '../core/packet.js';
import { D_STATE_INFO, P_STATES } from '../core/pm.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

const pct = (v) => `${Math.round(v * 100)}%`;
const n2 = (v) => Number(v).toFixed(2);
const n1 = (v) => Number(v).toFixed(1);

/** CDR 各锁定阶段的典型参数（用于阶段预览）。 */
const CDR_STAGE = {
  UNLOCKED: { ppm: 300, phase: 180, penalty: 6, eye: 0.25 },
  FREQ_LOCK: { ppm: 40, phase: 180, penalty: 4, eye: 0.45 },
  PHASE_LOCK: { ppm: 40, phase: 12, penalty: 2, eye: 0.7 },
  BIT_LOCK: { ppm: 0, phase: 2, penalty: 0, eye: 1 },
};

function sect(title, hint = '') {
  return `<p class="model-sect">${esc(title)}${hint ? `<span>${esc(hint)}</span>` : ''}</p>`;
}

/** 目标代际与实际工作代际可能不同（例如 Recovery.Speed 之前仍为 Gen1 2.5 GT/s）。 */
function rateTag(s) {
  const target = s.gen;
  const active = s.activeGen ?? target;
  return active === target
    ? `Gen${target} · ${s.rateGts} GT/s`
    : `目标 Gen${target} · 当前 Gen${active} ${s.rateGts} GT/s`;
}

function formula(lines, note = '') {
  return `<div class="formula">${lines.map((l) => `<div class="f-line">${l}</div>`).join('')}
    ${note ? `<div class="f-note">${note}</div>` : ''}</div>`;
}

function demo(svg, caption, guide = [], legend = '') {
  return `<div class="model-demo">${svg}<p class="demo-cap">${esc(caption)}</p>
    ${legend ? `<div class="demo-legend"><span class="lg-title">残差边界</span>${legend}</div>` : ''}
    ${guide.length ? `<ul class="demo-guide">${guide.map((g) => `<li>${g}</li>`).join('')}</ul>` : ''}</div>`;
}

function modelTable(rows) {
  return `<div class="table-scroll" style="margin-top:8px">
    <table class="compare model-table">
      <thead><tr><th>级</th><th>数学运算</th><th>当前数值</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td class="stage-col">${r[0]}</td><td>${r[1]}</td><td class="val-col">${r[2]}</td></tr>`).join('')}</tbody>
    </table>
  </div>`;
}

function kv(rows) {
  return `<dl class="kv">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
}

/* ---------- 架构图元件 ---------- */

function archBlock(x, y, w, h, title, expr, value, tone = '', key = '') {
  const attrs = key
    ? ` data-arch="${key}" role="button" tabindex="0" aria-label="${title}"`
    : '';
  return `<g class="arch-blk ${tone}"${attrs}>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9"/>
    <text class="blk-title" x="${x + w / 2}" y="${y + 18}" text-anchor="middle">${title}</text>
    <text class="blk-expr" x="${x + w / 2}" y="${y + 36}" text-anchor="middle">${expr}</text>
    <text class="blk-val" x="${x + w / 2}" y="${y + 53}" text-anchor="middle">${value}</text>
  </g>`;
}

function archArrow(x1, x2, y, label = '', key = '') {
  const dir = x2 >= x1 ? 1 : -1;
  const inner = `<line class="arch-hit" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/>
    <line class="arch-arrow" x1="${x1}" y1="${y}" x2="${x2 - 5 * dir}" y2="${y}"/>
    <polygon class="arch-head" points="${x2},${y} ${x2 - 8 * dir},${y - 4} ${x2 - 8 * dir},${y + 4}"/>
    ${label ? `<text class="arch-label" x="${(x1 + x2) / 2}" y="${y - 7}" text-anchor="middle">${label}</text>` : ''}`;
  return key
    ? `<g class="arch-link" data-arch="${key}" role="button" tabindex="0" aria-label="${label || key}">${inner}</g>`
    : inner;
}

/** 总线 / 差分对：TX / RX 两条独立通道，分段 + 斜杠表示可多条 lane。 */
function archBus(x1, x2, y, label = '', key = '', { lanes = 0 } = {}) {
  const dir = x2 >= x1 ? 1 : -1;
  const segs = 3;
  const gap = 12;
  const segLen = (Math.abs(x2 - x1) - gap * (segs - 1)) / segs;
  const row = (yy, forward, color) => {
    let out = '';
    for (let i = 0; i < segs; i += 1) {
      const sx = x1 + dir * i * (segLen + gap);
      out += `<line class="arch-arrow" style="stroke:${color}" x1="${sx}" y1="${yy}" x2="${sx + dir * segLen}" y2="${yy}"/>`;
    }
    for (let i = 0; i < segs - 1; i += 1) {
      const cx = x1 + dir * (i * (segLen + gap) + segLen + gap / 2);
      out += `<line class="arch-slash" style="stroke:${color}" x1="${cx - 2.5}" y1="${yy + 5}" x2="${cx + 2.5}" y2="${yy - 5}"/>`;
    }
    const tip = forward ? x2 : x1;
    out += `<polygon class="arch-head" style="fill:${color}" points="${tip},${yy} ${tip - 8 * dir * (forward ? 1 : -1)},${yy - 4} ${tip - 8 * dir * (forward ? 1 : -1)},${yy + 4}"/>`;
    return out;
  };
  const txY = y - 10;
  const rxY = y + 10;
  let inner = `<line class="arch-hit" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/>`;
  inner += row(txY, true, '#22d3ee');
  inner += row(rxY, false, '#f472b6');
  inner += `<text class="arch-label" x="${x2 - 2}" y="${txY - 6}" text-anchor="end" fill="#22d3ee">TX</text>`;
  inner += `<text class="arch-label" x="${x2 - 2}" y="${rxY - 6}" text-anchor="end" fill="#f472b6">RX</text>`;
  const text = lanes ? `${label} ×${lanes}` : label;
  if (text) {
    inner += `<text class="arch-label" x="${(x1 + x2) / 2}" y="${txY - 30}" text-anchor="middle">${text}</text>`;
  }
  return key
    ? `<g class="arch-link" data-arch="${key}" role="button" tabindex="0" aria-label="${text || key}">${inner}</g>`
    : inner;
}

/** 可点击的反馈支路（宽透明描边扩大命中区）。 */
function archFeedback(d, key = 'fb', aria = '反馈支路') {
  return `<g class="arch-link" data-arch="${key}" role="button" tabindex="0" aria-label="${aria}">
    <path class="arch-hit" d="${d}"/>
    <path class="arch-feedback" d="${d}"/>
  </g>`;
}

function archDot(path, dur = '5.5s', color = '#38bdf8') {
  return `<circle r="3.2" fill="${color}" opacity="0.95">
    <animateMotion dur="${dur}" repeatCount="indefinite" path="${path}"/>
  </circle>`;
}

/* ---------- EQ：信号链架构 ---------- */

/** 各 Phase 在架构图上的动态提示（外虚线框 + 阶段徽标 + 抽头内框）。 */
const EQ_PHASE_HINT = [
  { label: 'P0 · 预设扫描 P0–P10', tap: null },
  { label: 'P1 · FS / LF 调整', tap: null },
  { label: 'P2 · pre-cursor 调整', tap: 'pre' },
  { label: 'P3 · post-cursor 收敛', tap: 'post' },
];

function textWidth(str) {
  return [...str].reduce((n, c) => n + (/[\u4e00-\u9fa5]/.test(c) ? 8 : 4.8), 0);
}

/** 阶段提示：琥珀色流动虚线框 + 上方阶段徽标。 */
function phaseBox(x, y, w, h, label) {
  const badgeW = Math.round(textWidth(label) + 16);
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"
      fill="rgba(251,191,36,0.06)" stroke="#fbbf24" stroke-width="1.3" stroke-dasharray="6 4" pointer-events="none">
      <animate attributeName="stroke-dashoffset" from="0" to="-20" dur="1.4s" repeatCount="indefinite"/>
      <animate attributeName="stroke-opacity" values="0.5;1;0.5" dur="1.8s" repeatCount="indefinite"/>
    </rect>
    <rect x="${x}" y="${y - 24}" width="${badgeW}" height="15" rx="7"
      fill="rgba(251,191,36,0.14)" stroke="#fbbf24" stroke-opacity="0.65"/>
    <text class="arch-phase-badge" x="${x + 8}" y="${y - 13}">${label}</text>`;
}

function eqArch(s, phase = 0) {
  const y = 54;
  const h = 66;
  const w = 106;
  const mid = y + h / 2;
  const xs = [34, 168, 302, 436, 570];
  const ph = Math.max(0, Math.min(3, phase));
  const hint = EQ_PHASE_HINT[ph];
  const box = { x: xs[0] - 6, y: y - 8, w: w + 12, h: h + 16 };

  // 抽头数值按 4 字符 + 3 字符分隔排布，用于框出当前调整的系数
  const valStart = xs[0] + w / 2 - 40.5;
  const charW = 4.5;
  const tapX = hint.tap === 'pre' ? valStart : hint.tap === 'post' ? valStart + 14 * charW : null;

  return `<svg class="model-svg" viewBox="0 0 720 190" xmlns="http://www.w3.org/2000/svg">
    ${archDot(`M4,${mid} H716`)}
    ${archArrow(4, xs[0], mid, 'x[n]', 'in')}
    ${archBlock(xs[0], y, w, h, 'TX FFE', 'c₋₁z + c₀ + c₁z⁻¹',
    `${n2(s.eq.pre)} / ${n2(s.eq.cursor)} / ${n2(s.eq.post)}`, 'hot', 'ffe')}
    ${archArrow(xs[0] + w, xs[1], mid, 'y[n]', 'sig-y')}
    ${archBlock(xs[1], y, w, h, '信道', 'α₋₁z + 1 + α₁z⁻¹',
    `${s.channel.lossDb} dB · ${n2(s.channel.preIsi)}/${n2(s.channel.postIsi)}`, '', 'channel')}
    ${archArrow(xs[1] + w, xs[2], mid, 'r[n]', 'sig-r')}
    ${archBlock(xs[2], y, w, h, 'RX CTLE', 'G / (1 + s/ω_p)', `${s.rxEq.ctleDb} dB`, '', 'ctle')}
    ${archArrow(xs[2] + w, xs[3], mid, 'z₁[n]', 'sig-z1')}
    ${archBlock(xs[3], y, w, h, 'DFE', '−Σ dₖ·ŝ[n−k]', `${s.rxEq.dfeTaps} tap`, '', 'dfe')}
    ${archArrow(xs[3] + w, xs[4], mid, 'z[n]', 'sig-z')}
    ${archBlock(xs[4], y, w, h, '采样判决', 'E = 1 − ISI_res',
    `${pct(s.metrics.eyeOpening)} · COM ${n1(s.metrics.comDb)}`, s.metrics.comPass ? 'ok' : 'bad', 'sampler')}
    ${archArrow(xs[4] + w, 716, mid, 'bits', 'out')}

    <!-- 当前 Phase 的动态虚线提示 -->
    ${phaseBox(box.x, box.y, box.w, box.h, hint.label)}
    ${tapX !== null
    ? `<rect x="${(tapX - 3).toFixed(1)}" y="${y + 45}" width="${(4 * charW + 6).toFixed(1)}" height="12" rx="3"
        fill="none" stroke="#fde68a" stroke-width="1" stroke-dasharray="3 2" pointer-events="none">
        <animate attributeName="stroke-dashoffset" from="0" to="-10" dur="1s" repeatCount="indefinite"/>
      </rect>`
    : ''}

    <text class="arch-note" x="34" y="150">前馈 FFE 预失真 → 信道卷积产生 pre/post ISI → RX CTLE/DFE 抵消 → 采样器按眼开度判决</text>
    <text class="arch-note" x="34" y="168">点击方块或连线，查看该环节的数学公式与物理含义</text>
  </svg>`;
}

/* ---------- CDR：闭环架构 ---------- */

/** CDR 各锁定阶段在架构图上框选的环节。 */
const CDR_BOX = {
  UNLOCKED: { idx: 0, label: '未锁定 · 相位误差未收敛' },
  FREQ_LOCK: { idx: 2, label: '频率锁定 · VCO 频偏牵引' },
  PHASE_LOCK: { idx: 1, label: '相位锁定 · 环路收敛相位' },
  BIT_LOCK: { idx: 2, label: '位锁定 · 采样时钟稳定' },
};

function cdrArch(s, v, shown) {
  const y = 42;
  const h = 66;
  const w = 132;
  const mid = y + h / 2;
  const xs = [100, 290, 480];
  const hint = CDR_BOX[shown] || CDR_BOX.UNLOCKED;
  return `<svg class="model-svg" viewBox="0 0 720 200" xmlns="http://www.w3.org/2000/svg">
    ${archDot(`M8,${mid} H704`, '5.5s')}
    ${archFeedback('M546,108 V168 H166 V108')}
    ${archDot(`M546,108 V168 H166 V108`, '4.5s', '#c4b5fd')}
    ${archArrow(8, xs[0], mid, 'r(t) 数据边沿', 'in')}
    ${archBlock(xs[0], y, w, h, '相位检测 PD', 'φ_e = K_d(φ_in − φ_out)', `φ_e = ${v.phase}°`, 'hot', 'pd')}
    ${archArrow(xs[0] + w, xs[1], mid, 'φ_e', 'sig-pe')}
    ${archBlock(xs[1], y, w, h, '环路滤波', 'K_p + K_i / s', `${v.ppm} ppm`, '', 'lf')}
    ${archArrow(xs[1] + w, xs[2], mid, 'φ_c', 'sig-pc')}
    ${archBlock(xs[2], y, w, h, 'VCO / 采样时钟', 'f = f₀ + K_v·φ_c', cdrText(shown), shown === 'BIT_LOCK' ? 'ok' : '', 'vco')}
    <g class="arch-link" data-arch="out" role="button" tabindex="0" aria-label="输出 f_clk">
      <line class="arch-hit" x1="612" y1="${mid}" x2="704" y2="${mid}"/>
      <line class="arch-arrow" x1="612" y1="${mid}" x2="700" y2="${mid}"/>
      <polygon class="arch-head" points="704,${mid} 696,${mid - 4} 696,${mid + 4}"/>
      <text class="arch-label" x="656" y="${mid - 7}" text-anchor="middle">f_clk</text>
    </g>
    <g class="arch-link" data-arch="fb" role="button" tabindex="0" aria-label="反馈 φ_out">
      <polygon class="arch-head arch-head-fb" points="166,108 162,116 170,116"/>
      <text class="arch-label arch-label-fb" x="356" y="162" text-anchor="middle">反馈 φ_out（无分频）</text>
    </g>
    ${phaseBox(xs[hint.idx] - 6, y - 8, w + 12, h + 16, hint.label)}
    <text class="arch-note" x="14" y="188">闭环：PD 检测相位差 → 环路滤波 → VCO 调整采样时钟 → 反馈到 PD，使 φ_e → 0</text>
  </svg>`;
}

/* ---------- PLL：带 ÷N 反馈的闭环架构 ---------- */

function pllArch(s) {
  const y = 36;
  const h = 64;
  const w = 136;
  const mid = y + h / 2;
  const xs = [52, 220, 388];
  const nVal = Math.round(s.rateGts / (s.refClk.freqMHz / 1000));
  return `<svg class="model-svg" viewBox="0 0 720 200" xmlns="http://www.w3.org/2000/svg">
    ${archDot(`M8,${mid} H704`, '5.5s')}
    ${archFeedback('M456,100 V150 H346', 'fb', '反馈 f_fb（VCO → ÷N）')}
    ${archFeedback('M250,150 H120 V100', 'fb', '反馈 f_fb（÷N → PD）')}
    ${archDot(`M456,100 V150 H346 M250,150 H120 V100`, '4.5s', '#c4b5fd')}
    ${archArrow(8, xs[0], mid, 'REF CLK', 'in')}
    ${archBlock(xs[0], y, w, h, '鉴相器 PD', 'φ_e = φ_ref − φ_fb', 'φ_e → 0', 'hot', 'pd')}
    ${archArrow(xs[0] + w, xs[1], mid, 'φ_e', 'sig-pe')}
    ${archBlock(xs[1], y, w, h, '环路滤波', 'K_p + K_i / s', '锁定时间', '', 'lf')}
    ${archArrow(xs[1] + w, xs[2], mid, 'φ_c', 'sig-pc')}
    ${archBlock(xs[2], y, w, h, 'VCO', 'f = f₀ + K_v·φ_c', `${n1(s.pll.freqGHz)} GHz`, s.pll.locked ? 'ok' : '', 'vco')}
    <g class="arch-link" data-arch="out" role="button" tabindex="0" aria-label="输出 f_vco">
      <line class="arch-hit" x1="524" y1="${mid}" x2="704" y2="${mid}"/>
      <line class="arch-arrow" x1="524" y1="${mid}" x2="700" y2="${mid}"/>
      <polygon class="arch-head" points="704,${mid} 696,${mid - 4} 696,${mid + 4}"/>
      <text class="arch-label" x="612" y="${mid - 7}" text-anchor="middle">f_vco = N·f_REF</text>
    </g>
    <g class="arch-blk" data-arch="div" role="button" tabindex="0" aria-label="分频 ÷N">
      <rect x="250" y="132" width="96" height="36" rx="8"/>
      <text class="blk-title" x="298" y="147" text-anchor="middle">分频 ÷N</text>
      <text class="blk-val" x="298" y="161" text-anchor="middle">N = ${nVal}</text>
    </g>
    <g class="arch-link" data-arch="fb" role="button" tabindex="0" aria-label="反馈 f_fb">
      <polygon class="arch-head arch-head-fb" points="120,100 116,108 124,108"/>
      <text class="arch-label arch-label-fb" x="180" y="143" text-anchor="middle">f_fb</text>
    </g>
    ${phaseBox(xs[s.pll.locked ? 2 : 0] - 6, y - 8, w + 12, h + 16,
    s.pll.locked ? '已锁定 · φ_e → 0' : '未锁定 · 相位误差未收敛')}
    <text class="arch-note" x="14" y="192">闭环：VCO 输出经 ÷N 反馈到鉴相器，使 φ_e → 0；REF 频偏与 jitter 直接传递到输出时钟</text>
  </svg>`;
}

/* ---------- 动态演示 ---------- */

/** 生成方波路径（用于时钟波形演示）。 */
function squareWave(x0, yMid, period, amp, count) {
  const high = yMid - amp / 2;
  const low = yMid + amp / 2;
  let d = `M${x0},${low}`;
  for (let i = 0; i < count; i += 1) {
    d += ` h${period / 2} v${-amp} h${period / 2} v${amp}`;
  }
  return d;
}

/** EQ 各 Phase 典型预设的残差（占原始回声比例），用于柱状图边界与图例。 */
const PHASE_COLORS = ['#64748b', '#38bdf8', '#a78bfa', '#34d399'];

function eqPhaseResiduals(s) {
  const alphaPre = s.channel.preIsi;
  const alphaPost = s.channel.postIsi;
  const eff = 1 - s.rxEq.eff;
  return [2, 6, 8, s.bestPreset].map((idx, i) => {
    const p = EQ_PRESETS[idx];
    return {
      i,
      preset: p.name,
      pre: alphaPre * Math.max(0, 1 - p.pre / 0.35) * eff,
      post: alphaPost * Math.max(0, 1 - p.post / 0.45) * eff,
    };
  });
}

/** EQ 动态演示：信道回声被 FFE + CTLE/DFE 抵消，眼开度随之打开。 */
function eqDemo(s, phase = 0) {
  const base = 132;
  const cx = [186, 366, 546];
  const bw = 48;
  const ph = Math.max(0, Math.min(3, phase));
  const SHORT = ['预设扫描', 'FS/LF', 'pre-cursor', 'post-cursor'];
  const eyesPhase = [2, 6, 8, s.bestPreset].map((i) => (s.presetEyes || [])[i] ?? 0);
  const alphaPre = s.channel.preIsi;
  const alphaPost = s.channel.postIsi;
  const eff = 1 - s.rxEq.eff;
  const preRes = alphaPre * Math.max(0, 1 - s.eq.pre / 0.35) * eff;
  const postRes = alphaPost * Math.max(0, 1 - s.eq.post / 0.45) * eff;
  const hPre = 16 + alphaPre * 70;
  const hPost = 16 + alphaPost * 70;
  const hMain = 92;
  const rPre = 8 + preRes * 70;
  const rPost = 8 + postRes * 70;
  const openPct = Math.round(s.metrics.eyeOpening * 100);
  const dur = '4.5s';

  const animatedEcho = (x, h, r) => `<rect x="${x}" y="${base - h}" width="${bw}" height="${h}" fill="#38bdf8" opacity="0.75">
      <animate attributeName="height" values="${n1(h)};${n1(r)};${n1(r)};${n1(h)}" dur="${dur}" repeatCount="indefinite"/>
      <animate attributeName="y" values="${n1(base - h)};${n1(base - r)};${n1(base - r)};${n1(base - h)}" dur="${dur}" repeatCount="indefinite"/>
    </rect>`;

  const cmp = eyesPhase.map((e, i) => `<text class="demo-cmp${i === ph ? ' active' : ''}"
      x="${86 + i * 66}" y="176">P${i} ${Math.round(e * 100)}%</text>`).join('');

  // 只画当前阶段的残差边界，避免多条虚线堆叠
  const res = eqPhaseResiduals(s)[ph];
  const yp = base - (8 + res.pre * 70);
  const yq = base - (8 + res.post * 70);
  const boundary = `<line x1="${cx[0] - bw / 2 - 7}" y1="${n1(yp)}" x2="${cx[0] + bw / 2 + 7}" y2="${n1(yp)}"
      stroke="#fbbf24" stroke-width="1.4" stroke-dasharray="3 3"/>
    <line x1="${cx[2] - bw / 2 - 7}" y1="${n1(yq)}" x2="${cx[2] + bw / 2 + 7}" y2="${n1(yq)}"
      stroke="#fbbf24" stroke-width="1.4" stroke-dasharray="3 3"/>`;

  return `<svg class="model-svg" viewBox="0 0 720 200" xmlns="http://www.w3.org/2000/svg">
    <text class="demo-phase" x="16" y="20">Phase ${ph} · ${SHORT[ph]} · 预设 ${s.eq.name}</text>
    <line class="sv-axis" x1="40" y1="${base}" x2="690" y2="${base}"/>
    <text class="sv-label" x="${cx[0]}" y="${base + 13}" text-anchor="middle">−1 UI</text>
    <text class="sv-label" x="${cx[1]}" y="${base + 13}" text-anchor="middle">0（主光标）</text>
    <text class="sv-label" x="${cx[2]}" y="${base + 13}" text-anchor="middle">+1 UI</text>

    <rect class="sv-bar-ghost" x="${cx[0] - bw / 2}" y="${base - hPre}" width="${bw}" height="${hPre}"/>
    <rect class="sv-bar-ghost" x="${cx[2] - bw / 2}" y="${base - hPost}" width="${bw}" height="${hPost}"/>
    <rect x="${cx[1] - bw / 2}" y="${base - hMain}" width="${bw}" height="${hMain}" fill="#38bdf8"/>

    ${animatedEcho(cx[0] - bw / 2, hPre, rPre)}
    ${animatedEcho(cx[2] - bw / 2, hPost, rPost)}
    ${boundary}

    <text class="sv-val" x="${cx[0]}" y="${base - hPre - 5}" text-anchor="middle">α₋₁ ${n2(alphaPre)}</text>
    <text class="sv-val" x="${cx[1]}" y="${base - hMain - 5}" text-anchor="middle">cursor 1.00</text>
    <text class="sv-val" x="${cx[2]}" y="${base - hPost - 5}" text-anchor="middle">α₁ ${n2(alphaPost)}</text>
    <text class="sv-label" x="${cx[0]}" y="${base - rPre - 4}" text-anchor="middle">残 ${pct(preRes)}</text>
    <text class="sv-label" x="${cx[2]}" y="${base - rPost - 4}" text-anchor="middle">残 ${pct(postRes)}</text>

    <text class="sv-label" x="618" y="30">眼开度</text>
    <rect x="618" y="38" width="80" height="8" rx="4" fill="#12233c"/>
    <rect x="618" y="38" width="8" height="8" rx="4" fill="#34d399">
      <animate attributeName="width" values="8;${Math.max(8, Math.round(openPct * 0.8))};${Math.max(8, Math.round(openPct * 0.8))};8" dur="${dur}" repeatCount="indefinite"/>
    </rect>
    <text class="sv-val" x="658" y="62" text-anchor="middle">${openPct}%</text>
    <text class="sv-label" x="618" y="80">COM ${n1(s.metrics.comDb)} dB</text>
    <text class="sv-label" x="16" y="176">阶段对比</text>
    ${cmp}
    <text class="sv-label" x="360" y="176">残差 = 未抵消的 ISI 占比（越小眼开度越大）</text>
    <text class="sv-label" x="360" y="190">虚线 = 当前阶段残差边界（各阶段数值见下方图例）</text>
  </svg>`;
}

/** CDR 动态演示：采样相位从眼图边缘滑向眼心，恢复时钟与数据边界对齐。 */
function cdrDemo(s, v) {
  const eyePpm = Math.max(0, Math.min(300, v.ppm));
  const ppmWidth = Math.max(6, Math.round((1 - eyePpm / 300) * 240));
  const dataWave = squareWave(380, 58, 40, 34, 5);
  const clockWave = squareWave(380, 118, 40, 26, 5);
  const x0 = Math.round(180 - Math.max(0, Math.min(1, v.phase / 180)) * 100);
  const clockOff = Math.round((v.phase / 180) * 12);
  const ts = (v.phase / 360) * s.metrics.uiPs;
  const pam4 = !!s.metrics.pam4;
  const eyeShape = pam4
    ? `<path d="M60,80 C120,52 240,52 300,80" fill="none" stroke="#38bdf8" stroke-width="1.4" opacity="0.9"/>
    <path d="M60,108 C120,80 240,80 300,108" fill="none" stroke="#38bdf8" stroke-width="1.4" opacity="0.9"/>
    <path d="M60,136 C120,108 240,108 300,136" fill="none" stroke="#38bdf8" stroke-width="1.4" opacity="0.9"/>
    <line class="sv-axis" x1="60" y1="52" x2="300" y2="52" stroke-dasharray="2 4"/>
    <line class="sv-axis" x1="60" y1="80" x2="300" y2="80" stroke-dasharray="2 4"/>
    <line class="sv-axis" x1="60" y1="108" x2="300" y2="108" stroke-dasharray="2 4"/>
    <line class="sv-axis" x1="60" y1="136" x2="300" y2="136" stroke-dasharray="2 4"/>`
    : `<path d="M60,92 C120,30 240,30 300,92" fill="none" stroke="#38bdf8" stroke-width="1.4" opacity="0.9"/>
    <path d="M60,92 C120,154 240,154 300,92" fill="none" stroke="#38bdf8" stroke-width="1.4" opacity="0.9"/>`;
  const sampleYs = pam4 ? [66, 94, 122] : [58, 126];
  const sampleDots = sampleYs.map((cy) => `<circle cx="${x0}" cy="${cy}" r="3" fill="#fbbf24">
      <animate attributeName="cx" values="${x0};180;180;${x0}" dur="4.2s" repeatCount="indefinite"/>
    </circle>`).join('');

  return `<svg class="model-svg" viewBox="0 0 720 170" xmlns="http://www.w3.org/2000/svg">
    ${eyeShape}
    <line class="sv-axis" x1="60" y1="92" x2="300" y2="92" stroke-dasharray="2 4"/>
    <line x1="${x0}" y1="24" x2="${x0}" y2="160" stroke="#fbbf24" stroke-width="1.1" stroke-dasharray="4 3">
      <animate attributeName="x1" values="${x0};180;180;${x0}" dur="4.2s" repeatCount="indefinite"/>
      <animate attributeName="x2" values="${x0};180;180;${x0}" dur="4.2s" repeatCount="indefinite"/>
    </line>
    ${sampleDots}
    <text class="sv-label" x="180" y="166" text-anchor="middle">采样相位 φ = ${v.phase}° → t_s = ${n2(ts)} ps</text>
    <text class="sv-label" x="60" y="16">${pam4 ? 'PAM4 三 eye' : '眼图'} / UI ${n1(s.metrics.uiPs)} ps</text>

    <text class="sv-label" x="380" y="16">数据边沿</text>
    <path d="${dataWave}" fill="none" stroke="#60a5fa" stroke-width="1.4"/>
    <text class="sv-label" x="380" y="104">恢复时钟（锁定后对齐）</text>
    <g>
      <path d="${clockWave}" fill="none" stroke="#fbbf24" stroke-width="1.4" opacity="0.9"/>
      <animateTransform attributeName="transform" type="translate" values="${clockOff} 0;0 0;0 0;${clockOff} 0" dur="4.2s" repeatCount="indefinite"/>
    </g>

    <text class="sv-label" x="380" y="140">频偏 ${v.ppm} ppm</text>
    <rect x="380" y="146" width="240" height="6" rx="3" fill="#12233c"/>
    <rect x="380" y="146" width="6" height="6" rx="3" fill="#34d399">
      <animate attributeName="width" values="6;${ppmWidth};${ppmWidth};6" dur="4.2s" repeatCount="indefinite"/>
    </rect>
    <text class="sv-label" x="626" y="152">±300 ppm</text>
  </svg>`;
}

/** PLL 动态演示：REF 与 VCO 波形经 PLL 倍频衔接，红色区间表示 jitter。 */
function pllDemo(s) {
  // 低电平对齐连接线 y=58，波形首尾都在低电平，衔接处不会有台阶
  const refWave = squareWave(40, 43, 90, 30, 3);
  const vcoWave = squareWave(440, 43, 26, 30, 9);
  const nVal = Math.round(s.rateGts / (s.refClk.freqMHz / 1000));
  // jitter 相对 UI 极小（0.35 ps vs 125 ps），按 ×40 放大成可见的边沿抖动
  const jitterRatio = s.pll.jitterPs / Math.max(1e-6, s.metrics.uiPs);
  const jitterPx = Math.min(9, Math.max(4, jitterRatio * 26 * 40));
  const jf = jitterPx.toFixed(2);
  const jl = (-jitterPx).toFixed(2);
  const edgeX = 479;
  const edgeL = (edgeX - jitterPx).toFixed(2);
  const edgeR = (edgeX + jitterPx).toFixed(2);
  // 示波器网格
  const grid = [];
  for (let gx = 24; gx <= 704; gx += 32) {
    grid.push(`<line x1="${gx}" y1="8" x2="${gx}" y2="104" stroke="#0d2133" stroke-width="0.6"/>`);
  }
  for (let gy = 22; gy <= 104; gy += 18) {
    grid.push(`<line x1="10" y1="${gy}" x2="710" y2="${gy}" stroke="#0d2133" stroke-width="0.6"/>`);
  }
  const divPs = (s.metrics.uiPs * 4).toFixed(0);

  return `<svg class="model-svg" viewBox="0 0 720 170" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <clipPath id="pllJitterClip"><rect x="466" y="22" width="196" height="62"/></clipPath>
      <filter id="scopeGlow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="1.4" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>

    <!-- 示波器屏幕：底噪网格 + 扫描线 -->
    <rect x="8" y="6" width="704" height="100" rx="8" fill="#04121f" stroke="#1d3149"/>
    ${grid.join('')}
    <line x1="10" y1="58" x2="710" y2="58" stroke="#123049" stroke-dasharray="2 6"/>
    <line x1="10" y1="8" x2="10" y2="104" stroke="#38bdf8" stroke-width="10" opacity="0.035">
      <animate attributeName="x1" values="10;710;710" dur="7s" repeatCount="indefinite"/>
      <animate attributeName="x2" values="10;710;710" dur="7s" repeatCount="indefinite"/>
    </line>
    <line x1="10" y1="8" x2="10" y2="104" stroke="#7dd3fc" stroke-width="1.2" opacity="0.22">
      <animate attributeName="x1" values="10;710;710" dur="7s" repeatCount="indefinite"/>
      <animate attributeName="x2" values="10;710;710" dur="7s" repeatCount="indefinite"/>
    </line>

    <text class="sv-label" x="40" y="16">REF CLK ${s.refClk.freqMHz} MHz · ${s.refClk.ppm} ppm${s.refClk.ssc ? ' · SSC' : ''}</text>
    <path d="${refWave}" fill="none" stroke="#60a5fa" stroke-width="1.4" filter="url(#scopeGlow)"/>

    <rect x="320" y="36" width="80" height="44" rx="8" fill="#0c1729" stroke="#2b4162"/>
    <text class="sv-val" x="360" y="54" text-anchor="middle">PLL</text>
    <text class="sv-label" x="360" y="68" text-anchor="middle">×${nVal}</text>
    <line class="sv-axis" x1="310" y1="58" x2="320" y2="58"/>
    <line class="sv-axis" x1="400" y1="58" x2="440" y2="58"/>

    <text class="sv-label" x="440" y="16">VCO / 比特时钟 ${n1(s.pll.freqGHz)} GHz · jitter ${s.pll.jitterPs} ps</text>
    <path d="${vcoWave}" fill="none" stroke="#fbbf24" stroke-width="1.4" opacity="0.95" filter="url(#scopeGlow)"/>

    <!-- jitter：红色边沿标记来回抖动 + 红色波形叠加，直观显示边沿不确定度 -->
    <line x1="${edgeX}" y1="22" x2="${edgeX}" y2="68" stroke="#94a3b8" stroke-width="1"
      stroke-dasharray="3 4" opacity="0.9"/>
    <g clip-path="url(#pllJitterClip)" opacity="0.85">
      <g>
        <path d="${vcoWave}" fill="none" stroke="#f87171" stroke-width="1.5" filter="url(#scopeGlow)"/>
        <animateTransform attributeName="transform" type="translate"
          values="${jl} 0;${jf} 0;${jf} 0;${jl} 0" dur="2.4s" repeatCount="indefinite"/>
      </g>
    </g>
    <line x1="${edgeL}" y1="20" x2="${edgeL}" y2="70" stroke="#f87171" stroke-width="1.8">
      <animate attributeName="x1" values="${edgeL};${edgeR};${edgeR};${edgeL}" dur="2.4s" repeatCount="indefinite"/>
      <animate attributeName="x2" values="${edgeL};${edgeR};${edgeR};${edgeL}" dur="2.4s" repeatCount="indefinite"/>
    </line>
    <line class="sv-axis" x1="466" y1="24" x2="466" y2="68" stroke-dasharray="2 3"/>
    <line class="sv-axis" x1="662" y1="24" x2="662" y2="68" stroke-dasharray="2 3"/>
    <line x1="${edgeX}" y1="68" x2="${edgeX}" y2="76" stroke="#94a3b8" stroke-width="0.8" opacity="0.8"/>
    <text class="sv-label" x="${edgeX}" y="86" text-anchor="middle">理想边沿</text>
    <text class="sv-label" x="440" y="96">红色 = jitter ${s.pll.jitterPs} ps（示意） · 灰虚线 = 理想边沿</text>
    <text class="scope-tag" x="16" y="100">TRIG ↑ AUTO</text>
    <text class="scope-tag" x="704" y="100" text-anchor="end">${divPs} ps/div</text>

    <text class="sv-label" x="40" y="118">锁定时序：REF 边沿 → PLL 倍频 → VCO 边沿对齐（相位误差 → 0）</text>
    <text class="sv-label" x="40" y="136">UI = ${n1(s.metrics.uiPs)} ps · jitter/UI = ${((s.pll.jitterPs / s.metrics.uiPs) * 100).toFixed(2)}% · PLL ${s.pll.locked ? '已锁定' : '未锁定'}</text>
  </svg>`;
}

/* ---------- 三个模型 ---------- */

/** 各 Phase 的典型预设（Phase 0 初选 P2，Phase 1 调 FS/LF 到 P6，Phase 2 调 pre 到 P8，Phase 3 收敛到最佳）。 */
const EQ_PHASE_PRESET = [2, 6, 8, null];

/** 结合当前仿真阶段与预览阶段，生成用于展示的 EQ 参数。 */
function eqView(s, previewPhase) {
  const curPhase = Math.min(3, s.eq.phase);
  const phase = previewPhase == null ? curPhase : Math.max(0, Math.min(3, previewPhase));
  if (previewPhase == null || phase === curPhase) {
    return { phase, fromSim: true, eq: { ...s.eq, phase }, metrics: s.metrics, presetIndex: s.eq.presetIndex };
  }
  const presetIndex = phase === 3 ? s.bestPreset : EQ_PHASE_PRESET[phase];
  const p = EQ_PRESETS[presetIndex];
  const eye = (s.presetEyes || [])[presetIndex] ?? s.metrics.eyeOpening;
  const comDb = 20 * Math.log10(eye) + 10 + s.fecGainDb - s.cdrPenaltyDb;
  return {
    phase,
    fromSim: false,
    eq: {
      ...s.eq,
      phase,
      presetIndex,
      name: p.name,
      pre: p.pre,
      cursor: p.cursor,
      post: p.post,
      converged: phase === 3,
      eyeOpening: eye,
    },
    metrics: { ...s.metrics, eyeOpening: eye, comDb, comPass: comDb >= 3 },
    presetIndex,
  };
}

/** EQ（FFE + 信道 + CTLE/DFE）模型；previewPhase 可预览任一均衡阶段。 */
export function eqModel(s, previewPhase = null) {
  const curPhase = Math.min(3, s.eq.phase);
  const view = eqView(s, previewPhase);
  const eq = view.eq;
  const met = view.metrics;
  const sView = { ...s, eq, metrics: met };
  const eyes = s.presetEyes || [];

  const rows = EQ_PRESETS.map((p, i) => {
    const eye = eyes[i] ?? 0;
    const active = i === view.presetIndex;
    const best = i === s.bestPreset;
    return `<tr class="${active ? 'row-active' : ''}">
      <td>${p.name}${best ? ' <span class="tag-best">最佳</span>' : ''}</td>
      <td>${n2(p.pre)}</td>
      <td>${n2(p.cursor)}</td>
      <td>${n2(p.post)}</td>
      <td><span class="bar"><i style="width:${Math.round(eye * 100)}%"></i></span>${pct(eye)}</td>
    </tr>`;
  }).join('');

  const phases = ['Phase 0 · 预设扫描', 'Phase 1 · FS/LF', 'Phase 2 · pre-cursor', 'Phase 3 · post-cursor'];
  const steps = phases.map((t, i) => {
    const cls = i === view.phase ? ' active' : i < view.phase ? ' done' : '';
    return `<button type="button" class="model-step clickable${cls}" data-eq-phase="${i}"
      title="预览 ${t}">${t}</button>`;
  }).join('');

  const stageBar = `<div class="model-stage-bar">
    <div class="model-steps">${steps}</div>
    <div class="model-preview">${view.fromSim
    ? `当前仿真阶段：<b>Phase ${curPhase}</b> · 点击上方阶段可预览，运行时会自动跟随`
    : `预览阶段：<b>Phase ${view.phase}</b>（当前仿真：Phase ${curPhase}）
       <button type="button" class="model-reset" data-eq-reset>回到仿真状态</button>`}
    </div>
  </div>`;

  const preRes = s.channel.preIsi * Math.max(0, 1 - eq.pre / 0.35) * (1 - s.rxEq.eff);
  const postRes = s.channel.postIsi * Math.max(0, 1 - eq.post / 0.45) * (1 - s.rxEq.eff);

  return `<div class="model-head">
      <span class="model-badge">PHY · TX/RX EQ</span>
      ${rateTag(s)} · 信道损耗 ${s.channel.lossDb} dB
    </div>

    ${stageBar}

    ${sect('架构', '信号逐级处理 · 点击方块 / 连线查看解析')}
    ${eqArch(sView, view.phase)}

    ${sect('逐级运算')}
    ${modelTable([
    ['x[n]', '输入符号 x ∈ {−1, +1}', '1.00'],
    ['y[n]', 'c₋₁x[n+1] + c₀x[n] + c₁x[n−1]', `${n2(eq.pre)} / ${n2(eq.cursor)} / ${n2(eq.post)}`],
    ['r[n]', 'α₋₁x[n+1] + x[n] + α₁x[n−1]', `主 1.00，回声 ${n2(s.channel.preIsi)} / ${n2(s.channel.postIsi)}`],
    ['z[n]', '(1+η)·r[n] − Σ dₖ·ŝ[n−k]', `残余 ${pct(preRes)} / ${pct(postRes)}`],
    ['E', '1 − 残余 − 0.3(1−c₀)', `${pct(met.eyeOpening)} · COM ${n1(met.comDb)} dB`],
  ])}

    ${sect('建模假设')}
    <p class="model-assume">信道用 3 抽头（pre / main / post）线性近似；FFE 与 DFE 按线性叠加抵消 ISI；
      COM / 眼图为教学估算，用于展示趋势，不等同于规范中的完整 COM 算法。</p>

    ${sect('数学公式', '代入当前参数')}
    ${formula([
    'TX FFE：y[n] = c₋₁·x[n+1] + c₀·x[n] + c₁·x[n−1]，且 c₋₁ + c₀ + c₁ = 1',
    '信道：h[n] = α₋₁·δ[n+1] + δ[n] + α₁·δ[n−1]',
    '接收：z[n] = (1 + G_CTLE)·y_eq[n] − Σₖ dₖ·ŝ[n−k]（CTLE + DFE）',
    '眼开度：E = 1 − (α₋₁(1−c₋₁/0.35) + α₁(1−c₁/0.45))·(1−η) − 0.3·(1−c₀)',
    'COM = 20·lg(E) + 10 + G_FEC − P_CDR',
  ], `η = G_CTLE/20 + 0.05·N_DFE = ${n2(s.rxEq.eff)}；
     代入 c₋₁=${n2(eq.pre)}, c₀=${n2(eq.cursor)}, c₁=${n2(eq.post)}，α₋₁=${n2(s.channel.preIsi)}, α₁=${n2(s.channel.postIsi)}；
     得 E = ${n2(met.eyeOpening)}，COM = ${n1(met.comDb)} dB（阈值 3.0 dB）。`)}

    ${sect('动态演示', '回声随抽头收敛被逐步抵消 · 随阶段自动切换')}
    ${demo(eqDemo(sView, view.phase), `蓝色为信道原始回声，实心为均衡后的残余（pre ${pct(preRes)} / post ${pct(postRes)}）；右侧眼开度 ${pct(met.eyeOpening)}。`, [
    '<i class="sw blue"></i>蓝色柱＝信道产生的 pre / post 回声；实心柱＝均衡后的<b>残差</b>（残余 ISI 占原始回声的比例）。',
    `以 pre 为例，残差 ${pct(preRes)} 表示该方向 ISI 已被抵消 ${pct(1 - preRes / Math.max(1e-6, s.channel.preIsi))}；残差越小，眼开度与判决余量越大。`,
    `残差无法完全为 0：受 FFE 抽头精度、CTLE 增益与 DFE 抽头数限制；当前 <b>E=${pct(met.eyeOpening)}</b>、<b>COM=${n1(met.comDb)} dB</b>。`,
    '柱内虚线＝当前阶段残差边界；P0–P3 的 pre/post 残差数值见上方图例。',
  ], eqPhaseResiduals(s).map((r) => {
    const active = r.i === view.phase;
    return `<span class="lg-item${active ? ' active' : ''}"><i class="sw" style="background:${PHASE_COLORS[r.i]}"></i>P${r.i} ${r.preset} · pre ${pct(r.pre)} / post ${pct(r.post)}</span>`;
  }).join(''))}

    <div class="table-scroll" style="margin-top:6px">
      <table class="compare model-table">
        <thead><tr><th>预设</th><th>pre</th><th>cursor</th><th>post</th><th>均衡后眼开度</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint">P0–P10 为 PCIe Gen3 归一化 3 抽头预设。Phase 0 扫描全部预设取初值，
      Phase 1 调 FS/LF，Phase 2/3 分别调整 pre-cursor 与 post-cursor，最终收敛到最佳预设。</p>`;
}

/** CDR（时钟数据恢复）锁定过程模型；preview 可预览任一锁定阶段。 */
export function cdrModel(s, preview = null) {
  const order = ['UNLOCKED', 'FREQ_LOCK', 'PHASE_LOCK', 'BIT_LOCK'];
  const simState = s.cdr.state;
  const simIdx = Math.max(0, order.indexOf(simState));
  const shown = preview || simState;
  const idx = Math.max(0, order.indexOf(shown));
  const useSim = !preview || preview === simState;
  const v = useSim
    ? {
      ppm: s.cdr.freqErrorPpm,
      phase: s.cdr.phaseErrorDeg,
      penalty: s.cdrPenaltyDb,
      eye: [0.25, 0.45, 0.7, 1][simIdx],
    }
    : CDR_STAGE[preview];
  const ts = (v.phase / 360) * s.metrics.uiPs;

  const steps = order.map((st, i) => {
    const cls = i === idx ? ' active' : i < idx ? ' done' : '';
    return `<button type="button" class="model-step clickable${cls}" data-cdr-stage="${st}"
      title="预览 ${cdrText(st)}">${i + 1} · ${cdrText(st)}</button>`;
  }).join('');

  const note = `<div class="model-preview">${preview && preview !== simState
    ? `预览阶段：<b>${cdrText(shown)}</b>（当前仿真：${cdrText(simState)}）
       <button type="button" class="model-reset" data-cdr-reset>回到仿真状态</button>`
    : `当前仿真状态：<b>${cdrText(simState)}</b> · 点击上方阶段可预览对应锁定过程`}
  </div>`;

  const stageBar = `<div class="model-stage-bar">
    <div class="model-steps">${steps}</div>
    ${note}
  </div>`;

  return `<div class="model-head">
      <span class="model-badge">PHY · CDR</span>
      ${rateTag(s)} · UI ${s.metrics.uiPs.toFixed(0)} ps
    </div>

    ${stageBar}

    ${sect('架构', '相位闭环 · 点击方块 / 连线查看解析')}
    ${cdrArch(s, v, shown)}

    ${sect('逐级运算')}
    ${modelTable([
    ['PD', 'φ_e = K_d·(φ_in − φ_out)', `${v.phase}°`],
    ['LF', 'K_p·φ_e + K_i·∫φ_e dt', `${v.ppm} ppm`],
    ['VCO', 'f = f₀ + K_v·φ_c', cdrText(shown)],
    ['采样', 't_s = (φ_e/360°)·UI', `${n2(ts)} ps（UI ${n1(s.metrics.uiPs)} ps）`],
    ['判决', 'F = f(state)，P_CDR = g(F)', `${pct(v.eye)} · −${n1(v.penalty)} dB`],
  ])}

    ${sect('建模假设')}
    <p class="model-assume">CDR 简化为二阶环路：鉴相器输出相位误差 φ_e，环路滤波（比例 + 积分）驱动 VCO；
      频率牵引范围按 ±300 ppm 近似，SSC 作为额外周期频偏叠加。</p>

    ${sect('数学公式', '代入当前参数')}
    ${formula([
    '频偏：Δf = (f_TX − f_RX) / f_TX × 10⁶  (ppm)',
    '环路：f_VCO = N·f_REF + K_p·φ_e + K_i·∫φ_e dt',
    '采样相位：t_s = (φ_e / 360°)·UI',
    '眼因子：F = 1.00 / 0.70 / 0.45 / 0.25（BIT / PHASE / FREQ / UNLOCK）',
    'CDR 惩罚：P_CDR = 0 / 2 / 4 / 6 dB（与 F 对应）',
  ], `当前 φ_e = ${v.phase}°，UI = ${n1(s.metrics.uiPs)} ps → t_s = ${n2(ts)} ps；
      Δf = ${v.ppm} ppm（牵引范围 ±300 ppm），F = ${n2(v.eye)}，P_CDR = ${v.penalty} dB。`)}

    ${sect('动态演示', '采样点滑向眼心，恢复时钟与数据对齐')}
    ${demo(cdrDemo(s, v), `黄色竖线为采样相位，从眼图边缘逐步滑向眼心；下方恢复时钟相对数据边沿的偏移收敛到 0。`, [
    '<i class="sw amber"></i>黄色竖线＝采样相位；黄色圆点＝判决采样点（PAM4 时为上/中/下三个眼）。',
    '恢复时钟相对数据边沿的偏移收敛到 0，表示相位锁定；竖线停在眼心即最佳采样位置。',
    `当前 <b>φ_e=${v.phase}°</b> → <b>t_s=${n2(ts)} ps</b>，眼因子 <b>F=${pct(v.eye)}</b>，CDR 惩罚 −${v.penalty} dB。`,
  ])}

    <p class="hint">锁定顺序：频率锁定（匹配发送端比特速率）→ 相位锁定（采样点对准眼心）→ 位锁定（连续无滑动）。
      未锁定时眼高/眼宽按 25% / 45% / 70% / 100% 衰减，并计入 COM 惩罚。SSC 使频偏周期变化，CDR 环路带宽需覆盖。</p>`;
}

/** REF CLK / PLL 时钟模型。 */
export function pllModel(s) {
  const nVal = s.rateGts / (s.refClk.freqMHz / 1000);
  return `<div class="model-head">
      <span class="model-badge">PHY · REF CLK / PLL</span>
      ${rateTag(s)}
    </div>

    ${sect('架构', '带 ÷N 反馈的锁频环 · 点击方块 / 连线查看解析')}
    ${pllArch(s)}

    ${sect('逐级运算')}
    ${modelTable([
    ['PD', 'φ_e = φ_ref − φ_fb', 'φ_e → 0（锁定）'],
    ['LF', 'K_p + K_i / s', '环路带宽 / 锁定时间'],
    ['VCO', 'f_vco = N·f_ref', `${n1(s.pll.freqGHz)} GHz`],
    ['÷N', 'f_fb = f_vco / N', `N = ${nVal.toFixed(0)}`],
    ['输出', 'UI = 1/f_rate，J_r = t_j/UI', `${n1(s.metrics.uiPs)} ps · ${((s.pll.jitterPs / s.metrics.uiPs) * 100).toFixed(2)}%`],
  ])}

    ${sect('建模假设')}
    <p class="model-assume">PLL 视为理想倍频器 + 相位噪声：输出频率严格为 N×REF，附加 jitter 以固定 RMS 值近似；
      REF 频偏与 SSC 直接传递到 VCO，由 CDR 跟踪。</p>

    ${sect('数学公式', '代入当前参数')}
    ${formula([
    '倍频：f_VCO = N · f_REF，N = f_rate / f_REF',
    'UI：UI = 1 / f_rate',
    'jitter 占比：J_r = t_jitter / UI',
    'SSC：Δf(t) = −(d/2)·(1 − cos(2π·f_m·t))，d = 5000 ppm，f_m = 30 kHz',
  ], `N = ${s.rateGts} / 0.1 = ${nVal.toFixed(0)}；UI = ${n1(s.metrics.uiPs)} ps；
     J_r = ${s.pll.jitterPs} / ${n1(s.metrics.uiPs)} = ${((s.pll.jitterPs / s.metrics.uiPs) * 100).toFixed(2)}%；
     SSC 峰值频偏约 −5000 ppm（三角/余弦近似）。`)}

    ${sect('动态演示', 'REF 边沿与 VCO 边沿对齐，红色叠加波形为 jitter 示意')}
    ${demo(pllDemo(s), `REF ${s.refClk.freqMHz} MHz 经 ×${nVal.toFixed(0)} 倍频得到 ${n1(s.pll.freqGHz)} GHz；
      红色叠加波形为 jitter ${s.pll.jitterPs} ps 的放大示意，边沿对齐表示已锁定。`, [
    '<i class="sw blue"></i>蓝色＝REF 时钟；<i class="sw amber"></i>黄色＝VCO 倍频时钟；<i class="sw red"></i>红色＝jitter 抖动（放大约 40×）。',
    '<i class="sw dash"></i>灰虚线＝理想边沿；红色竖线在实际边沿附近往复，偏移幅度对应 jitter。',
    `示波器网格与扫描线为示意；水平刻度 <b>${(s.metrics.uiPs * 4).toFixed(0)} ps/div</b>（4 UI/格）。`,
    `当前 <b>jitter/UI=${((s.pll.jitterPs / s.metrics.uiPs) * 100).toFixed(2)}%</b>，PLL <b>${s.pll.locked ? '已锁定' : '未锁定'}</b>。`,
  ])}

    <p class="hint">REF CLK 为 100 MHz 差分时钟，PLL 倍频到串行比特时钟；jitter 占 UI 比例越大，采样余量越小。
      ±ppm 偏差与 SSC（0 ~ −5000 ppm 调制）由 CDR 跟踪，超出牵引范围会导致失锁。</p>`;
}

/** Gen1–6 参数差异对照，并说明“目标代际 vs 当前工作点”。 */
export function genModel(s) {
  const target = s.gen;
  const active = s.activeGen ?? target;
  const rows = [1, 2, 3, 4, 5, 6].map((g) => {
    const rate = GEN_RATE[g];
    const eq = RX_EQ_BY_GEN[g] ?? RX_EQ_BY_GEN[3];
    const isTarget = g === target;
    const isActive = g === active;
    return `<tr class="${isTarget ? 'row-active' : ''}">
      <td>Gen${g}${isActive ? ' <span class="tag-current">当前</span>' : ''}</td>
      <td>${rate.toFixed(1)} GT/s</td>
      <td>${g === 6 ? 'PAM4' : 'NRZ'}</td>
      <td>${encodingOf(g)}</td>
      <td>${PHY_CHANNEL_LOSS[g]} dB</td>
      <td>${eq.ctleDb} dB / ${eq.dfeTaps} tap</td>
      <td>${g === 6 ? '+3 dB' : '—'}</td>
      <td>${(1000 / rate).toFixed(1)} ps</td>
    </tr>`;
  }).join('');

  return `<div class="model-head">
      <span class="model-badge">PHY · Gen 对照</span>
      ${rateTag(s)} · UI ${s.metrics.uiPs.toFixed(1)} ps
    </div>

    ${sect('当前工作点')}
    ${kv([
    ['目标代际', `Gen${target}（${GEN_RATE[target]} GT/s · ${encodingOf(target)}）`],
    ['当前代际', `Gen${active}（${s.rateGts} GT/s${active === 6 ? ' · PAM4' : ' · NRZ'}）`],
    ['信道损耗', `${s.channel.lossDb} dB`],
    ['RX EQ', `CTLE ${s.rxEq.ctleDb} dB · DFE ${s.rxEq.dfeTaps} tap`],
    ['FEC', s.fecGainDb ? `+${s.fecGainDb} dB` : '未启用'],
    ['眼图', s.metrics.pam4
      ? `PAM4 · 3 eye（单眼 ${s.metrics.eyeHeightPerEyeMv.toFixed(0)} mV）`
      : `NRZ · 1 eye（${s.metrics.eyeHeightMv.toFixed(0)} mV）`],
  ])}

    ${sect('代际参数对照', '高亮行为目标代际')}
    <div class="table-scroll" style="margin-top:8px">
      <table class="compare model-table">
        <thead><tr><th>代际</th><th>速率</th><th>调制</th><th>线码</th><th>信道损耗</th><th>CTLE / DFE</th><th>FEC</th><th>UI</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    ${sect('差异要点')}
    <ul class="model-list">
      <li>速率每代翻倍，UI 从 400 ps 缩到 15.6 ps，眼宽与采样余量同步收紧。</li>
      <li>信道损耗 8 → 36 dB，ISI 加剧，接收端 CTLE 0 → 7 dB、DFE 0 → 2 tap 逐代增强。</li>
      <li>线码：Gen1/2 为 8b/10b（约 20% 开销），Gen3–5 为 128b/130b（约 1.5%），Gen6 为 1b/1b + FEC。</li>
      <li>Gen6 使用 PAM4：4 电平、上/中/下 3 eye，单眼高度约为 NRZ 的 1/3，靠 FEC 补偿 SNR 损失。</li>
    </ul>

    <p class="hint">“目标 Gen3 · 当前 Gen1 2.5 GT/s”不是参数错误：模型按目标代际配置信道损耗与 RX EQ，
      而 PHY 场景在 Recovery.Speed 之前仍以 2.5 GT/s 工作，完成变速后才切到目标速率。
      教学模型未单列 Gen6 PAM4 约 9.5 dB 的 SNR 惩罚，也未区分各代 FFE 预设集合。</p>`;
}

/* ---------- PM：电源管理 / 唤醒架构 ---------- */

export const L_STATE_ROWS = [
  ['L0', '正常工作态：TLP / DLLP 全速双向传输，REF CLK、主电源、PLL 全开', '开', '开', '保持', '正常传输', '—'],
  ['L0s', '待机态（仅 Non-Flit）：链路进入电气空闲 EIOS，用 FTS 快速恢复位锁，平台不参与', '开', '开', '保持', 'FTS 快速退出（仅 Non-Flit）', 'ns–µs'],
  ['L0p', 'Flit 模式低功耗态（Gen6）：只关空闲 Lane 子集，其余 Lane 继续传 Flit', '开', '开', '保持（部分 Lane 低功耗）', 'FTS 恢复被关 Lane（仅 Flit）', 'ns–µs'],
  ['L1', '低功耗待机：主电源与链路上下文保持，可关 REF CLK / PLL（取决于子状态），退出走 Recovery', '开', '可关', '保持', 'CLKREQ# → Recovery', 'µs 级'],
  ['L1.0', 'L1 子状态：REF CLK 与 PLL 都保持，退出最快', '开', '开', '保持', 'CLKREQ# + Recovery', 'µs 级'],
  ['L1.1', 'L1 子状态：关 REF CLK、保持 PLL；退出需平台先恢复参考时钟', '开', '关', '保持', 'CLKREQ# → REF CLK → Recovery', '数 µs'],
  ['L1.2', 'L1 子状态：REF CLK 与 PLL 都关；退出需 CLKREQ# 恢复时钟并重新锁定 PLL', '开（PHY 门控）', '关', '保持', 'CLKREQ# → 上电 → Recovery', '数十 µs'],
  ['L2', '低功耗睡眠：主电源与时钟关闭、仅 Vaux 供电，上下文丢失，退出需恢复主电源并全速重训练', '关（仅 Vaux）', '关', '丢失', 'Beacon / WAKE# → 主电源 → Detect 重训练', 'ms 级'],
  ['L3', '完全断电：连 Vaux 也可关闭，需上电 + Fundamental Reset 才能回到 Detect', '关（仅 Vaux）', '关', '丢失', '同 L2，链路不可用', 'ms 级'],
];

/** PCIe 6.2 §5.2 Table 5-1：链路电源状态与平台资源的关系。 */
const PM_L_SPEC = [
  ['L0 / L0p', '全速工作（Fully active Link）', 'Yes (D0)', 'Yes (D0)', '开', '开', '开', '开 / 关'],
  ['L0s', '待机（Standby state）', 'No', 'Yes¹（可选，D0）', '开', '开', '开', '开 / 关'],
  ['L1', '低功耗待机（Lower power standby）', 'Yes (D1–D3Hot)', 'Yes（可选，D0）', '开 / 关*', '开', '开 / 关‡', '开 / 关'],
  ['L2/L3 Ready\n（伪状态）', '移除电源前的暂存点（Staging point）', 'Yes³', 'No', '开 / 关*', '开', '开 / 关', '开 / 关'],
  ['L2', '低功耗睡眠（时钟与主电源关）', 'Yes⁴', 'No', '关', '关', '关', '开⁵'],
  ['L3', '完全断电（zero power）', 'n/a', 'n/a', '关', '关', '关', '关'],
  ['LDn\n（伪状态）', '回到 L0 前的过渡态', 'Yes', 'n/a', '开', '开', '开 / 关', '开 / 关'],
];

const PM_L_NOTES = [
  'L0s 退出延迟在两端使用独立参考时钟输入（而非公共分布式时钟）的链路配置中最大。',
  '内部关闭 PLL 的组件，其 L1 退出延迟最大。',
  'L2/L3 Ready 进入序列在 PME_Turn_Off / PME_TO_Ack 握手完成时启动；它不直接对应 D 状态迁移，也不对应 ASPM 策略流程。',
  '平台可选择使用 L2、转到完全断电（L3），或把链路留在 L2/L3 Ready。该进入协议由下游组件在收到并确认 PME_Turn_Off TLP Message 后启动；L2 睡眠配置支持可选（取决于 Vaux 可用性），但组件对 L2/L3 Ready 迁移的协议支持必需。',
  'L2 与 L3 的唯一区别是 Vaux 的存在与使用；L2/L3 Ready 迁移协议完成、主电源移除之前，链路已表示其可移除主电源。',
  '低功耗移动 / 手持设备可通过 CLKREQ# 时钟请求机制门控参考时钟省电；面向这类设备的组件应容忍低功耗退出时重新使能参考时钟带来的额外延迟。',
];

/** 电源管理三层：D（软件）/ L（链路）/ P（PHY），三者的来源与可见性完全不同。 */
export const PM_LAYERS = [
  ['D 状态', 'PM 软件写 PMCSR.PowerState：D0 / D1 / D2 / D3hot / D3cold', '软件可见、可控制',
    '设备功耗级别，是软件协商、保存 / 恢复上下文的入口'],
  ['L 状态', '由 D 状态与 ASPM 推导，LTSSM 执行：L0 / L0s / L0p / L1 / L1ss / L2 / L3',
    '通常不可见（仅调试 / 状态寄存器）', '链路能否传数据、时钟与上下文是否保留；D0 可处于 L0 / L0s / L1 / L0p'],
  ['P 状态', 'PHY 内部的 PIPE PowerDown 编码：P0 / P1 / P2，由 PHY 实现', '不可见，软件不直接控制',
    'PHY 电路与 PLL 的门控深度；同一 L 状态可由不同 P 档实现，不能把 P 与 L1 / L2 画等号'],
];

/** D / P 状态定义（D 为 PCI-PM 设备状态；P 为 PIPE PowerDown 编码，不是性能档）。 */
export const D_DEF = {
  D0: '工作态：全功能可用；上电或复位后先处于 D0uninitialized，软件完成配置后进入 D0active。D0 期间链路仍可由 ASPM 进出 L0s / L1 / L0p',
  D1: '轻睡眠（可选实现）：保留大部分上下文，仅关闭部分时钟；不响应 TLP，退出需软件写 PMCSR',
  D2: '深睡眠（可选实现）：关闭更多功能单元、丢失更多上下文；同样由软件驱动参与保存与恢复',
  D3hot: '主电源保持：Vcc 与 Vaux 仍在，配置空间可访问，可写 PMCSR 回 D0；D3hot ≠ L3 —— 此时 LTSSM 仍供电',
  D3cold: '主电源移除：仅 Vaux 可用，配置空间不可访问；若 Vaux 也移除则链路处于 L3，LTSSM 已断电，必须重新上电 + Fundamental Reset',
};

export const P_DEF = {
  P0: 'PIPE PowerDown=00：PHY 全速工作，PLL 与 PCLK 有效；L0 / L0p 中仍在传输的 Lane 使用',
  P1: 'PIPE PowerDown=01：PLL 保持、时钟与部分电路门控，恢复较快；浅低功耗的 PHY 实现通常用此档',
  P2: 'PIPE PowerDown=10：PLL 与大部分 PHY 电路关断，最省电、恢复最慢；深低功耗的 PHY 实现通常用此档',
};

const WAKE_ROWS = [
  ['FTS（L0s / L0p）', 'L0s（Non-Flit）/ L0p（Flit）', '在进入空闲的 Lane 上发 N_FTS 个 FTS，快速恢复位锁 / 符号锁；L0p 只影响被关闭的 Lane 子集', '无需平台参与，延迟最短'],
  ['CLKREQ#', 'L1.0 / L1.1 / L1.2', '设备拉低开漏信号 → 平台恢复 REF CLK → PLL 锁定 → Recovery', '时钟门控 / 边带上拉'],
  ['Beacon', 'L2', 'Vaux 下在差分对发送低频脉冲串 → RC 检测 → 主电源恢复 → Detect 重训练', 'Beacon 检测电路'],
  ['WAKE#', 'L2 / D3cold', '设备拉低开漏边带 → 平台恢复主电源 → 释放复位 → Detect 重训练', 'WAKE# 引脚'],
  ['PME / PM_PME', '链路可用后（L0）', 'Message 0x18 上报唤醒原因；不负责把链路拉起来', '仅需中断与软件'],
];

/** 平台 / RP / EP 的真实交互时序（按场景切换）。 */
const PM_SEQ = {
  l0s: {
    label: 'L0s / L0p 快速低功耗',
    hint: 'L0s：EIOS 进入、FTS 退出（Non-Flit）；L0p：只关部分 Lane，其余继续传 Flit（Gen6）',
    steps: [
      { from: 'RP', to: 'EP', kind: 'phy', label: '无 TLP 调度：允许进入快速低功耗' },
      { from: 'RP', to: 'EP', kind: 'phy', label: 'L0s：双向 EIOS → 发送端电气空闲' },
      { from: 'EP', to: 'RP', kind: 'phy', label: '退出：N_FTS 个 FTS → 恢复位锁 / 符号锁' },
      { from: 'RP', to: 'EP', kind: 'dllp', label: 'L0p 请求（Flit 模式）：协商可关闭的 Lane 子集' },
      { from: 'RP', to: 'EP', kind: 'phy', label: 'L0p：被选中的 Lane 进入低功耗，其余继续传 Flit' },
      { from: 'EP', to: 'RP', kind: 'phy', label: 'L0p 退出：被关 Lane 发 FTS → 恢复全宽' },
    ],
  },
  l1: {
    label: 'L1 进入 / CLKREQ# 唤醒',
    hint: 'DLLP 协商 → 关 REF CLK（L1.1）→ 电源门控（L1.2）→ CLKREQ# 唤醒 → Recovery',
    steps: [
      { from: 'EP', to: 'RP', kind: 'dllp', label: 'PM_Active_State_Request_L1（请求进入 L1）' },
      { from: 'RP', to: 'EP', kind: 'dllp', label: 'PM_Request_Ack（同意进入 L1）' },
      { from: 'RP', to: 'EP', kind: 'phy', label: '双向 EIOS → 电气空闲' },
      { from: 'EP', to: 'PLAT', kind: 'side', label: '释放 CLKREQ#（→ L1.1 关闭 REF CLK）' },
      { from: 'EP', to: 'PLAT', kind: 'side', label: 'L1.2：PHY 电源门控（保持 Vcc / Vaux）' },
      { from: 'EP', to: 'PLAT', kind: 'side', label: '拉低 CLKREQ#（唤醒）' },
      { from: 'PLAT', to: 'RP', kind: 'side', label: '恢复 REF CLK，等待稳定 → PLL 锁定' },
      { from: 'RP', to: 'EP', kind: 'phy', label: 'Recovery：TS1 → TS2 → L0' },
    ],
  },
  l2: {
    label: 'L2 进入 / Beacon 唤醒',
    hint: '关机握手 → 移除 Vcc → Beacon 唤醒 → 恢复电源与复位 → 全量重训练',
    steps: [
      { from: 'PLAT', to: 'RP', kind: 'msg', label: '软件把设备置于 D3hot / 准备 L2' },
      { from: 'RP', to: 'EP', kind: 'msg', label: 'PME_Turn_Off（要求设备准备断电）' },
      { from: 'EP', to: 'RP', kind: 'msg', label: 'PME_TO_Ack（确认可以断电）' },
      { from: 'RP', to: 'EP', kind: 'dllp', label: 'PM_Enter_L23（链路进入 L2/L3）' },
      { from: 'PLAT', to: 'EP', kind: 'side', label: '关闭 Vcc，仅保留 Vaux' },
      { from: 'EP', to: 'PLAT', kind: 'side', label: 'Beacon：差分对低频脉冲串（Vaux 供电）' },
      { from: 'PLAT', to: 'RP', kind: 'side', label: '恢复 Vcc / REF CLK，释放 PERST#' },
      { from: 'RP', to: 'EP', kind: 'phy', label: 'Detect → Polling → Configuration → L0' },
      { from: 'EP', to: 'RP', kind: 'msg', label: 'PM_PME（链路可用后上报原因）' },
    ],
  },
  hp: {
    label: '热插拔：插入 / 拔出',
    hint: 'PRSNT# → 槽位上电 → PERST# 释放 → 训练 → DLLSC 中断 → 安全拔出',
    steps: [
      { from: 'PLAT', to: 'RP', kind: 'side', label: 'PRSNT# 变为 0（插卡检测）' },
      { from: 'PLAT', to: 'RP', kind: 'msg', label: 'Slot Control：Power Controller 上电' },
      { from: 'PLAT', to: 'RP', kind: 'side', label: '电源稳定后释放 PERST#' },
      { from: 'RP', to: 'EP', kind: 'phy', label: 'Detect → Polling → Configuration → L0' },
      { from: 'RP', to: 'PLAT', kind: 'msg', label: 'DLLSC → 热插拔中断（软件读 Slot Status）' },
      { from: 'EP', to: 'PLAT', kind: 'side', label: 'Attention Button（请求安全拔出）' },
      { from: 'PLAT', to: 'RP', kind: 'msg', label: '关闭槽位电源 → 允许拔卡（MRL 开锁）' },
    ],
  },
};

const PM_SCN_ORDER = ['l0s', 'l1', 'l2', 'hp'];

const SEQ_KIND = {
  dllp: { color: '#22d3ee', name: 'DLLP' },
  msg: { color: '#fb923c', name: 'Message' },
  side: { color: '#c4b5fd', name: '边带 / 电源' },
  phy: { color: '#38bdf8', name: 'PHY / 链路' },
};

const PM_ACTORS = [
  { key: 'PLAT', x: 96, label: '平台 / ACPI', color: '#f59e0b' },
  { key: 'RP', x: 336, label: 'RP / 下游端口', color: '#38bdf8' },
  { key: 'EP', x: 576, label: 'EP / 设备', color: '#34d399' },
];

/** 时序图：三条生命线 + 编号消息 + 流动点，体现真实握手顺序。 */
function pmSeqSvg(scnKey) {
  const scn = PM_SEQ[scnKey] || PM_SEQ.l1;
  const xOf = (k) => (PM_ACTORS.find((a) => a.key === k) || PM_ACTORS[0]).x;
  const startY = 70;
  const gap = 34;
  const height = startY + scn.steps.length * gap + 18;
  const heads = PM_ACTORS.map((a) => `<g>
      <rect x="${a.x - 74}" y="8" width="148" height="24" rx="7"
        fill="rgba(15,30,51,0.95)" stroke="${a.color}" stroke-opacity="0.65"/>
      <text class="blk-title" x="${a.x}" y="24" text-anchor="middle" fill="${a.color}">${a.label}</text>
      <line x1="${a.x}" y1="34" x2="${a.x}" y2="${height - 10}"
        stroke="${a.color}" stroke-opacity="0.35" stroke-dasharray="3 5"/>
    </g>`).join('');

  const steps = scn.steps.map((st, i) => {
    const y = startY + i * gap;
    const x1 = xOf(st.from);
    const x2 = xOf(st.to);
    const dir = x2 >= x1 ? 1 : -1;
    const kind = SEQ_KIND[st.kind] || SEQ_KIND.msg;
    const mid = (x1 + x2) / 2;
    const lw = textWidth(st.label) + 12;
    return `<g>
      <circle cx="22" cy="${y}" r="8" fill="rgba(56,189,248,0.12)" stroke="${kind.color}" stroke-opacity="0.7"/>
      <text class="arch-note" x="22" y="${y + 3}" text-anchor="middle" fill="${kind.color}">${i + 1}</text>
      <line x1="${x1}" y1="${y}" x2="${x2 - 6 * dir}" y2="${y}" stroke="${kind.color}" stroke-width="1.3"/>
      <polygon points="${x2},${y} ${x2 - 8 * dir},${y - 4} ${x2 - 8 * dir},${y + 4}" fill="${kind.color}"/>
      <rect x="${mid - lw / 2}" y="${y - 20}" width="${lw}" height="13" rx="3"
        fill="#0d1a2d" fill-opacity="0.94" pointer-events="none"/>
      <text class="arch-label" x="${mid}" y="${y - 8}" text-anchor="middle">${st.label}</text>
      <circle r="2.6" fill="${kind.color}" opacity="0.9">
        <animateMotion dur="1.6s" begin="${(i * 0.42).toFixed(2)}s" repeatCount="indefinite"
          path="M${x1},${y} H${x2}"/>
      </circle>
    </g>`;
  }).join('');

  return `<svg class="model-svg" viewBox="0 0 720 ${height}" xmlns="http://www.w3.org/2000/svg">
    ${heads}${steps}
  </svg>`;
}

const PM_SIGNALS = [
  ['PERST#', '平台 → RP / EP', '低有效复位', 'Vcc 稳定后才释放；未释放前不得训练'],
  ['REF CLK', '平台 → RP / EP', '100 MHz 差分', 'L1.1 起可关闭；恢复后需等 PLL 重新锁定'],
  ['phy_ref_clk_req_n / local_ref_clk_req_n', 'PHY ↔ 控制器', '低有效请求', 'L1.1 取回 REFCLK；控制器再经 CLKREQ# 转发到平台'],
  ['phy_clk_req_n', 'PHY → 控制器', '低有效请求', 'PHY 请求 PCLK；时钟去除方案下参与 L1 子状态握手'],
  ['mac_phy_pclkchangeack / phy_mac_pclkchangeok', '控制器 ↔ PHY', '握手', 'PCLK 频率 / MAXPCLK 模式变更的确认'],
  ['aux_clk_active', '外部逻辑 → 控制器', '电平状态', '= 0 表示 pipe_clk 未切到 aux_clk，控制器停在 L1 子状态'],
  ['CLKREQ#', 'EP → 平台', '开漏、低有效', 'L1 / L1SS 唤醒；对 L2 无效'],
  ['WAKE#', 'EP → 平台', '开漏、低有效', 'L2 / D3cold 唤醒，与 Beacon 二选一'],
  ['Beacon', 'EP → RP（差分对）', '低频脉冲串', 'L2 唤醒；依赖 RC 常驻 Vaux 检测'],
  ['PME_Turn_Off / PME_TO_Ack', 'RP ↔ EP', 'Message', '进入 L2/L3 前的关机握手'],
  ['PM_Enter_L23', 'RP → EP', 'DLLP', '确认链路进入 L2/L3'],
  ['PM_Active_State_Request_L1 / Ack', 'EP ↔ RP', 'DLLP', 'ASPM 自主 L1 的请求与确认'],
  ['PM_PME', 'EP → RP', 'Message 0x18', '链路可用后上报唤醒原因'],
  ['PRSNT# / ATNBTN#', '槽位 → RP', '机械 / 按键', '热插拔事件源，与 D/L 状态独立'],
];

const PM_CONSTRAINTS = [
  ['1', 'L0s 仅用于 Non-Flit；Flit 模式（Gen6）用 L0p 替代', 'Flit 模式未定义 L0s，混用会导致状态机错误'],
  ['2', 'L0p 只关闭部分 Lane，其余 Lane 必须保持传输能力', '全部 Lane 关闭等价于进入更深的 L1'],
  ['3', 'CLKREQ# 拉低之前，平台不得关闭 REF CLK', '否则设备无法恢复时钟，只能靠复位重来'],
  ['4', 'REF CLK 稳定且 PLL 锁定后，才能进入 Recovery', '否则 TS1 无法被正确采样，训练失败'],
  ['5', 'PERST# 只能在 Vcc 稳定后释放', '复位释放过早会导致链路训练反复失败'],
  ['6', 'L2 唤醒必须从 Detect 开始全量训练', 'L2 期间链路上下文与时钟均已丢失'],
  ['7', 'PM_PME 只能在链路回到 L0 后发送', 'Message 依赖正常 TLP 路径'],
  ['8', 'Beacon / WAKE# 需要 Vaux 供电', '主电源关闭时这是唯一的唤醒手段'],
];

function pmArch(pm, link, hp, phy) {
  const lState = link.ports.RC.state;
  const rate = phy?.rateGts ?? 0;
  const lanes = link.width ?? 0;
  // TX / RX 是两条独立差分通道，方向以 RP 为视角：TX = RP → EP，RX = EP → RP
  const linkTx = 'M658,148 V228 H474 V280';
  const linkRx = 'M466,280 V220 H650 V148';
  return `<svg class="model-svg" viewBox="0 0 760 486" xmlns="http://www.w3.org/2000/svg">
    <!-- 基板 / 平台 -->
    <rect x="8" y="18" width="736" height="196" rx="12"
      fill="rgba(30,58,95,0.12)" stroke="#2b4162" stroke-dasharray="6 4"/>
    <text class="arch-note" x="20" y="36">基板 / 平台（Board）</text>

    ${archBlock(20, 52, 140, 96, '平台 / ACPI', 'Vcc · Vaux · REF CLK', 'PERST# · 唤醒检测', 'hot', 'platform')}
    ${archBlock(238, 52, 112, 96, 'RP 控制器', 'LTSSM · Slot Control', lState, '', 'rp')}
    ${archBlock(428, 52, 96, 96, 'RP PHY', 'SerDes · PLL · CDR', `${rate} GT/s`, '', 'rpphy')}
    ${archBlock(602, 52, 104, 96, 'Slot / 连接器', 'PRSNT# · ATNBTN#', `Power ${hp.powerController}`, '', 'slot')}

    ${archArrow(160, 238, 100, '电源/时钟', 'pwr')}
    ${archBus(350, 428, 100, '并行总线', 'rp-ctrl', { lanes })}
    ${archBus(524, 602, 100, '差分对', 'link', { lanes })}
    ${archDot('M160,100 H238', '3.8s', '#f59e0b')}
    ${archDot('M350,90 H428', '2.6s', '#22d3ee')}
    ${archDot('M428,110 H350', '3.4s', '#f472b6')}
    ${archDot('M524,90 H602', '2.2s', '#22d3ee')}
    ${archDot('M602,110 H524', '3s', '#f472b6')}

    <!-- 槽位电源：平台 → 连接器 → EP 卡 -->
    <path d="M90,148 V180 H654 V152" fill="none" stroke="#f59e0b" stroke-width="1.1" stroke-dasharray="4 3"/>
    <text class="arch-note" x="330" y="175" text-anchor="middle" fill="#f59e0b">Vcc / Vaux / 槽位电源</text>

    <!-- REF CLK：平台 → RP PHY -->
    <path d="M120,148 V164 H476 V150" fill="none" stroke="#fbbf24" stroke-width="1.1" stroke-dasharray="2 4"/>
    <polygon points="476,148 472,156 480,156" fill="#fbbf24"/>
    <text class="arch-note" x="300" y="158" text-anchor="middle" fill="#fbbf24">REF CLK → RP PHY</text>

    <!-- REF CLK：平台 → 连接器 → EP PHY -->
    <path d="M70,148 V196 H380 V300 H408" fill="none" stroke="#fbbf24" stroke-width="1.1" stroke-dasharray="2 4"/>
    <polygon points="412,300 404,296 404,304" fill="#fbbf24"/>
    <g class="arch-link" data-arch="refclk" role="button" tabindex="0" aria-label="REF CLK 100 MHz → EP PHY">
      <rect x="168" y="181" width="164" height="14" fill="transparent"/>
      <text class="arch-note" x="250" y="191" text-anchor="middle" fill="#fbbf24">REF CLK 100 MHz → EP PHY</text>
    </g>

    <!-- EP 卡 -->
    <rect x="400" y="246" width="308" height="140" rx="12"
      fill="rgba(30,58,95,0.12)" stroke="#2b4162" stroke-dasharray="6 4"/>
    <text class="arch-note" x="490" y="264">EP 卡（Add-in Card）</text>
    ${archBlock(412, 280, 132, 88, 'EP PHY', 'SerDes · PLL · CDR', `${rate} GT/s`, '', 'epphy')}
    ${archBlock(552, 280, 144, 88, 'EP 控制器', 'PMCSR · D / P 状态', `${pm.dstate} · ${pm.pstateName}`, '', 'ep')}

    <!-- 链路：TX / RX 两条独立差分通道（RP 视角），斜杠表示多条 lane -->
    <path d="${linkTx}" fill="none" stroke="#22d3ee" stroke-width="1.2"/>
    <path d="${linkRx}" fill="none" stroke="#f472b6" stroke-width="1.2"/>
    <line x1="512" y1="222" x2="518" y2="234" stroke="#22d3ee" stroke-width="1.1" stroke-opacity="0.9"/>
    <line x1="552" y1="222" x2="558" y2="234" stroke="#22d3ee" stroke-width="1.1" stroke-opacity="0.9"/>
    <line x1="512" y1="214" x2="518" y2="226" stroke="#f472b6" stroke-width="1.1" stroke-opacity="0.9"/>
    <line x1="552" y1="214" x2="558" y2="226" stroke="#f472b6" stroke-width="1.1" stroke-opacity="0.9"/>
    <polygon points="474,280 470,272 478,272" fill="#22d3ee"/>
    <polygon points="650,148 646,156 654,156" fill="#f472b6"/>
    <rect x="612" y="168" width="84" height="14" rx="2" fill="#1b2c45" stroke="#f59e0b" stroke-opacity="0.7"/>
    <text class="arch-note" x="654" y="178" text-anchor="middle" fill="#f59e0b">金手指</text>
    <text class="arch-label" x="636" y="196" text-anchor="end" fill="#f472b6">RX</text>
    <text class="arch-label" x="664" y="196" fill="#22d3ee">TX</text>
    <text class="arch-label" x="552" y="210" text-anchor="middle">Link：差分对（经连接器）</text>
    <circle r="3" fill="#22d3ee"><animateMotion dur="3.6s" repeatCount="indefinite" path="${linkTx}"/></circle>
    <circle r="2.6" fill="#f472b6"><animateMotion dur="4.4s" repeatCount="indefinite" path="${linkRx}"/></circle>

    <!-- CLKREQ# / WAKE# / Beacon：EP 控制器 → 连接器右侧 → Slot → 平台 -->
    <path d="M696,324 H730 V100 H712" fill="none" stroke="#c4b5fd" stroke-width="1.2" stroke-dasharray="4 3"/>
    <polygon points="706,100 714,96 714,104" fill="#c4b5fd"/>
    <g class="arch-link" data-arch="clkreq" role="button" tabindex="0" aria-label="CLKREQ# / WAKE# 边带">
      <rect x="640" y="228" width="86" height="15" fill="transparent"/>
      <text class="arch-note" x="722" y="239" text-anchor="end" fill="#c4b5fd">CLKREQ# / WAKE#</text>
    </g>
    <circle r="2.6" fill="#c4b5fd"><animateMotion dur="4.2s" repeatCount="indefinite"
      path="M696,324 H730 V100 H712"/></circle>

    <!-- 门控细节：折叠入口，点击后在浮窗里展开 -->
    <g class="arch-link" data-arch="clkgate" role="button" tabindex="0" aria-label="CLKREQ# → REF CLK 门控（RP / EP）折叠详情">
      <rect x="12" y="412" width="344" height="26" rx="13"
        fill="#0f1e33" stroke="#fbbf24" stroke-opacity="0.55" stroke-dasharray="4 3"/>
      <text class="arch-note" x="26" y="429" fill="#fbbf24">▸ CLKREQ# → REF CLK 门控（RP / EP）</text>
      <text class="arch-note" x="342" y="429" text-anchor="end" fill="#7f95b3">点击展开</text>
    </g>

    <text class="arch-note" x="16" y="462">实线＝数据通道：青色 TX（RP→EP）、粉色 RX（EP→RP）；紫色＝CLKREQ# / WAKE#；橙色虚线＝电源 / REF CLK。</text>
    <text class="arch-note" x="16" y="476">唤醒：EP 先拉低 CLKREQ# → REF CLK 恢复 → PLL 锁定 → Recovery；L2 下 CLKREQ# 无效。</text>
  </svg>`;
}

/** 四条唤醒路径的动态演示。 */
function pmWakeDemo() {
  const rows = [
    { y: 16, color: '#34d399', nodes: ['L0s / L0p', 'EIOS / 部分 Lane 休眠', 'N_FTS', 'L0'] },
    { y: 62, color: '#38bdf8', nodes: ['L1.2', 'CLKREQ#', 'REF CLK / PLL', 'Recovery → L0'] },
    { y: 108, color: '#fbbf24', nodes: ['L2', 'Beacon / WAKE#', '主电源恢复', 'Detect → 重训练'] },
    { y: 154, color: '#f472b6', nodes: ['L0', 'PM_PME', 'RC 中断', '软件读 PMCSR'] },
  ];
  const w = 132;
  const gap = 26;
  const paths = rows.map((r) => {
    let x = 20;
    let out = '';
    r.nodes.forEach((n, i) => {
      out += `<rect x="${x}" y="${r.y}" width="${w}" height="32" rx="8"
        fill="#0f1e33" stroke="${r.color}" stroke-opacity="0.75"/>
        <text class="arch-note" x="${x + w / 2}" y="${r.y + 20}" text-anchor="middle" fill="${r.color}">${n}</text>`;
      if (i < r.nodes.length - 1) {
        const x1 = x + w;
        const x2 = x + w + gap;
        out += `<line x1="${x1}" y1="${r.y + 16}" x2="${x2 - 5}" y2="${r.y + 16}" stroke="${r.color}" stroke-width="1.2"/>
          <polygon points="${x2},${r.y + 16} ${x2 - 6},${r.y + 12} ${x2 - 6},${r.y + 20}" fill="${r.color}"/>`;
      }
      x += w + gap;
    });
    out += `<circle r="2.8" fill="${r.color}"><animateMotion dur="4.4s" repeatCount="indefinite" path="M20,${r.y + 16} H${x - gap}"/></circle>`;
    return out;
  }).join('');

  return `<svg class="model-svg" viewBox="0 0 720 210" xmlns="http://www.w3.org/2000/svg">
    ${paths}
    <text class="arch-note" x="20" y="202">L0s / L0p 用 FTS 就地恢复；L1 需 CLKREQ# 要回时钟；L2 需 Beacon / WAKE# 恢复电源并全量重训练；PM_PME 只上报原因。</text>
  </svg>`;
}

function stateTable(headers, rows, activeIndex = -1) {
  const head = headers.map((h) => `<th>${h}</th>`).join('');
  const body = rows.map((r, i) => `<tr class="${i === activeIndex ? 'row-active' : ''}">${r
    .map((c) => `<td>${esc(c).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('');
  return `<div class="table-scroll" style="margin-top:8px">
    <table class="compare model-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
  </div>`;
}

/** PM 电源管理模型：平台 / RP / EP 交互 + L / D / P 状态 + 唤醒路径。 */
export function pmModel(ctx, scn = 'l1') {
  const { pm, link, hotplug } = ctx;
  const lState = link.ports.RC.state;
  const scnKey = PM_SEQ[scn] ? scn : 'l1';
  const scnDef = PM_SEQ[scnKey];
  const lActive = (() => {
    const exact = L_STATE_ROWS.findIndex((r) => r[0] === lState);
    if (exact >= 0) return exact;
    return L_STATE_ROWS.findIndex((r) => lState.startsWith(`${r[0]}.`));
  })();

  // Table 5-1 中当前 L 状态对应的行（L1.x 归到 L1，L0p 归到 L0 / L0p）
  const specState = /^L1/.test(lState) ? 'L1'
    : /^L0s/.test(lState) ? 'L0s'
      : /^L0/.test(lState) ? 'L0' : lState;
  const specActive = PM_L_SPEC.findIndex((r) => r[0] === specState
    || r[0].startsWith(`${specState}（`) || r[0].startsWith(`${specState} /`));

  const dRows = Object.keys(D_STATE_INFO).map((k) => {
    const d = D_STATE_INFO[k];
    return [d.name, d.link, d.powerW === undefined ? '由 P 状态决定' : `${d.powerW} W`, D_DEF[k], d.desc];
  });
  const dActive = Object.keys(D_STATE_INFO).indexOf(pm.dstate);

  const pRows = P_STATES.map((p) => [p.name, p.pipe, p.pll, p.clk, `${p.powerW} W`, P_DEF[p.name]]);
  const pActive = P_STATES.findIndex((p) => p.name === pm.pstateName);

  return `<div class="model-head">
      <span class="model-badge">PM · 电源管理</span>
      ${pm.dstate} · ${pm.pstateName} · 链路 ${lState} · ${pm.powerW.toFixed(1)} W
    </div>

    ${sect('架构', '板级拓扑：平台 → RP 控制器 / PHY → Slot → EP 卡 · 点击方块查看机制')}
    ${pmArch(pm, link, hotplug, ctx.phy)}

    ${sect('交互模型', '平台 / RP / EP 之间的真实握手时序 · 点击切换场景')}
    <div class="model-stage-bar">
      <div class="model-steps">${PM_SCN_ORDER.map((k) => `<button type="button"
          class="model-step clickable${k === scnKey ? ' active' : ''}" data-pm-scn="${k}">${PM_SEQ[k].label}</button>`).join('')}</div>
      <div class="model-preview">${scnDef.hint}</div>
    </div>
    ${demo(pmSeqSvg(scnKey), `${scnDef.label}：编号即握手顺序，箭头方向即驱动方 → 响应方；流动点表示信号传播。`, [
    '<i class="sw blue"></i>PHY / 链路：EIOS、Recovery、Detect 等链路级动作。',
    '<i class="sw amber"></i>DLLP / Message：L1 请求确认、PME_Turn_Off、PM_PME 等带内握手。',
    '<i class="sw dash"></i>边带 / 电源：CLKREQ#、WAKE#、Beacon、Vcc/Vaux、PERST#。',
    `当前仿真：D 状态 <b>${pm.dstate}</b>，链路 <b>${lState}</b>，PME ${pm.pmeEn ? '使能' : '关闭'}。`,
  ])}

    ${sect('信号交互', '谁驱动、谁响应、电气类型与使用条件')}
    ${stateTable(['信号 / 报文', '方向', '电气 / 类型', '约束'], PM_SIGNALS)}

    ${sect('握手约束', '时序不变量：违反后会出现训练失败或唤醒失效')}
    ${stateTable(['#', '时序不变量', '违反后果'], PM_CONSTRAINTS)}

    ${sect('三层状态', 'D（软件）/ L（链路）/ P（PHY）来源不同，不能互相等同')}
    ${stateTable(['层', '来源 / 控制者', '软件可见性', '含义'], PM_LAYERS)}
    <p class="hint">D 状态由 PM 软件写 PMCSR 控制，软件可见；L 状态由 D 状态与 ASPM 推导、LTSSM 执行，软件通常不可见；
      P 状态是 PHY/PIPE 的 powerdown 编码，由 PHY 实现，不能与 L1 / L2 画等号。</p>

    ${sect('L 状态', '由 D 状态与 ASPM 推导：L0 / L0p / L0s / L1（含 L1ss 子状态）/ L2 的定义、电源、时钟、上下文与唤醒方式')}
    ${stateTable(['L 状态', '定义', '主电源', 'REF CLK', '链路上下文', '唤醒 / 退出', '退出延迟'], L_STATE_ROWS, lActive)}
    <p class="hint">L1ss 指 L1 Substates（L1.0 / L1.1 / L1.2）三个子状态，进入与退出都经 CLKREQ# 协商；L0s 只用于 Non-Flit，L0p 只用于 Flit（Gen6）。
      这些状态由 LTSSM 自动维护，软件通常只通过调试口或状态寄存器观察。</p>

    ${sect('L 状态 × 平台资源', 'PCIe 6.2 §5.2 Table 5-1：软件 / ASPM 可控性与 REF CLK、主电源、内部 PLL、Vaux 的对应关系')}
    ${stateTable(['L 状态', '说明', 'S/W Directed PM', 'ASPM', 'REF CLK', '主电源', '内部 PLL', 'Vaux'], PM_L_SPEC, specActive)}
    <p class="hint">* Yes 表示必须支持（另有说明除外）；开 / 关 表示该状态必须提供的时钟与供电；开 / 关 表示可选的设计选择；‡ 取决于平台实现。</p>
    <ol class="pm-notes">${PM_L_NOTES.map((n) => `<li>${n}</li>`).join('')}</ol>

    ${sect('D 状态', '软件层：由 PM 软件写 PMCSR.PowerState 控制，软件可见 · D1 / D2 / D3hot 的进入与退出都由软件发起')}
    ${stateTable(['D 状态', '对应链路（推导）', '典型功耗', '定义', '说明'], dRows, dActive)}
    <p class="hint">D0 期间链路可在 L0 / L0s / L0p / L1 之间自动切换；D1 / D2 / D3hot 通常推导为 L1；
      D3hot 不等于 L3 —— D3hot 时 Vcc 与 LTSSM 仍在，可写 PMCSR 回 D0，而 L3 时 LTSSM 已断电。</p>

    ${sect('P 状态', 'PHY 层：PIPE PowerDown 编码（P0 / P1 / P2），由 PHY 实现，软件不直接控制')}
    ${stateTable(['P 状态', 'PowerDown 编码', 'PLL', 'PCLK / 时钟', '典型 PHY 功耗', '定义'], pRows, pActive)}
    <p class="hint">P 状态只描述 PHY 的门控深度，不等同于链路 L 状态：同一 P 档可服务不同 L 状态，也不能由 P 档反推 L 状态（P2 ≠ L2）。
      D3cold 无法靠写 PMCSR 退出，必须经 Fundamental Reset 或重新上电。</p>

    ${sect('唤醒机制', 'L0s / L0p / CLKREQ# / Beacon / WAKE# / PME 的物理过程与适用状态')}
    ${demo(pmWakeDemo(), '四条唤醒路径：L0s / L0p 用 FTS 就地恢复，L1 用 CLKREQ# 要回参考时钟，L2 用 Beacon / WAKE# 恢复主电源，PM_PME 只上报唤醒原因。', [
    '<i class="sw green"></i>FTS：L0s（Non-Flit）与 L0p（Flit）退出时在被关闭的 Lane 上恢复位锁，无需平台参与。',
    '<i class="sw blue"></i>CLKREQ#：开漏低有效边带；仅适用 L1 及 L1 子状态。',
    '<i class="sw amber"></i>Beacon：L2 下 Vaux 供电、在差分对发低频脉冲串，RC 检测后恢复主电源。',
    '<i class="sw red"></i>PM_PME：Message 0x18，链路可用后才发出，只说明“为什么醒”。',
    `当前链路 <b>${lState}</b>，D 状态 <b>${pm.dstate}</b>，PME ${pm.pmeEn ? (pm.pmeStatus ? '<b>挂起</b>' : '使能') : '关闭'}。`,
  ])}
    ${stateTable(['唤醒源', '适用状态', '物理过程', '平台配合'], WAKE_ROWS)}

    ${sect('建模假设')}
    <p class="model-assume">把电源管理拆成三层：D 状态是软件层（PMCSR，软件可见），L 状态是链路层（由 D + ASPM 推导，LTSSM 执行），
      P 状态是 PHY 层（PIPE PowerDown 编码，由 PHY 实现）。模型只保留与唤醒相关的电源、时钟与边带，
      不模拟电压斜坡、PLL 锁定时间的具体数值；退出延迟按数量级给出。</p>

    ${sect('数学公式', '功耗与退出延迟的简化表达')}
    ${formula([
    '总功耗：P_total = P_D(dstate) + P_PHY(Pstate) + P_leak',
    'L1 退出：t_exit = t_clk + t_pll + t_recovery',
    'L2 退出：t_exit = t_pwr + t_rst + t_detect + t_train',
    'D→L（推导）：D0 → L0 / L0s / L0p / L1，D1 / D2 → L1，D3hot → L1 / L2/L3 Ready，D3cold → L2 / L3',
  ], `当前 P_D = ${pm.powerW.toFixed(1)} W（${pm.dstate}），链路 ${lState}。
     L1.2 的 t_clk 与 t_pll 占比最大；L2 额外包含主电源恢复与完整重训练，因此是 ms 级。`)}

    <p class="hint">D 状态回答“软件把设备置于什么功耗级别”，L 状态回答“链路当前能否传数据”，P 状态回答“PHY 门控到什么深度”。
      热插拔是槽位能力，与 D/L 状态独立，但同样会触发链路重新训练。</p>`;
}

/* ---------- RAS：可靠性 / 可用性 / 可维护性 ---------- */

const RAS_ERRORS = [
  ['Correctable', 'LCRC 错误经 Replay 纠正、ECC 纠正、Replay Timer 重传', 'ERR_COR（可选上报）',
    '记录 AER Correctable 计数与 Header Log，不打断链路；持续增多说明物理层裕量不足'],
  ['Non-Fatal', 'Poisoned TLP、Completion Timeout、Malformed / Unexpected Completion、Bad DLLP',
    'ERR_NONFATAL', '数据完整性受影响但链路仍可用；由软件按策略做 FLR / 驱动复位 / 重试'],
  ['Fatal', 'Surprise Down、Receiver Overflow、Training Error、DL Protocol Error', 'ERR_FATAL',
    '链路或组件不可继续工作，需要 Hot Reset / Secondary Bus Reset / 热插拔换卡后重新枚举'],
];

const RAS_MECHS = [
  ['AER', 'Correctable / Uncorrectable Status、Mask、Severity、Header Log、Source ID',
    '检测结果的“账本”：分级、屏蔽、定位到具体 Function'],
  ['DPC', '下游端口检测到不可纠正错误后立即停止转发，阻止错误 TLP 继续下泄',
    '隔离：把故障限制在受影响端口以下，保护主机与上游'],
  ['EDR', 'DPC 触发后允许 EP 在隔离状态下完成链路恢复（Enhanced DPC）',
    '缩短停机时间，恢复完成后重新使能链路'],
  ['Hot-Plug', 'Surprise Down / 链路丢失后由热插拔控制器重新上电并枚举',
    '现场可维护性：换卡即恢复，对应「热插拔」场景'],
  ['FLR', 'Function Level Reset：只复位单个 Function，同卡其它功能不受影响',
    '驱动级恢复，代价最小'],
  ['Hot Reset / SBR', '链路级 / 总线级复位，重建链路与配置空间',
    'Fatal 错误的兜底恢复，代价最大'],
];

/** 带方向箭头的高对比连线：实线＝硬件路径，虚线＝软件 / 外部处理。 */
function rasFlow(x1, y1, x2, y2, {
  color = '#f87171', width = 2.2, dash = '', head = true, key = '', anim = 0,
} = {}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const hx = x2 - ux * 8;
  const hy = y2 - uy * 8;
  const headSvg = head
    ? `<polygon class="ras-head" style="fill:${color}"
        points="${x2},${y2} ${hx - uy * 4.2},${hy + ux * 4.2} ${hx + uy * 4.2},${hy - ux * 4.2}"/>`
    : '';
  const dotSvg = anim
    ? `<circle r="2.8" style="fill:${color}">
        <animateMotion dur="${anim}s" repeatCount="indefinite" path="M${x1},${y1} L${x2},${y2}"/>
      </circle>`
    : '';
  const style = `stroke:${color};stroke-width:${width}${dash ? `;stroke-dasharray:${dash}` : ''}`;
  const inner = `<line class="arch-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>
    <line class="ras-flow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="${style}"/>
    ${headSvg}${dotSvg}`;
  return key
    ? `<g class="arch-link" data-arch="${key}" role="button" tabindex="0" aria-label="${key}">${inner}</g>`
    : inner;
}

/** 检测点：一个可点击的层次探针（PHY / DL / TL）。 */
function rasTap(x, y, w, h, title, expr, color) {
  return `<g class="arch-link" data-arch="detect" role="button" tabindex="0" aria-label="${title}">
    <rect class="ras-tap" x="${x}" y="${y}" width="${w}" height="${h}" rx="8" style="stroke:${color}"/>
    <text class="blk-title" x="${x + w / 2}" y="${y + 17}" text-anchor="middle">${title}</text>
    <text class="blk-expr" x="${x + w / 2}" y="${y + 31}" text-anchor="middle" style="fill:${color}">${expr}</text>
  </g>`;
}

function rasArch(aer, dpc) {
  const ERR = '#f87171';
  const EXT = '#f472b6';
  const REC = '#34d399';
  return `<svg class="model-svg" viewBox="0 0 720 344" xmlns="http://www.w3.org/2000/svg">
    <!-- 设备 / 端口边界：检测、分级、隔离都在设备内部 -->
    <rect class="ras-boundary" x="6" y="30" width="556" height="280" rx="14"/>
    <text class="ras-sub" x="16" y="46">设备 / 端口边界：PHY · DL · TL + AER + DPC</text>

    <!-- 输入：PHY / DL / TL 三个检测点 -->
    ${rasTap(24, 64, 112, 44, 'PHY 检测', '编码 / Disparity', '#fbbf24')}
    ${rasTap(24, 118, 112, 44, 'DL 检测', 'LCRC / Replay', '#22d3ee')}
    ${rasTap(24, 172, 112, 44, 'TL 检测', 'ECRC / Poison', '#60a5fa')}
    ${rasFlow(136, 86, 204, 86, { color: '#fbbf24', anim: 3.2 })}
    ${rasFlow(136, 140, 204, 140, { color: '#22d3ee', anim: 3.6 })}
    ${rasFlow(136, 194, 204, 194, { color: '#60a5fa', anim: 4 })}

    <!-- 分级：MUX（软件配置 Severity / Mask 作为选择端） -->
    <g class="arch-link" data-arch="severity" role="button" tabindex="0" aria-label="分级 MUX">
      <path class="ras-mux" d="M206,64 L206,216 L296,184 L296,96 Z"/>
      <text class="blk-title" x="240" y="128" text-anchor="middle">分级</text>
      <text class="blk-expr" x="240" y="142" text-anchor="middle">MUX</text>
      <text class="ras-sub" x="240" y="155" text-anchor="middle">AER Severity</text>
      <text class="ras-tag" x="240" y="170" text-anchor="middle" style="fill:#fbbf24">3 类严重级别</text>
    </g>
    ${rasFlow(250, 22, 250, 62, { color: '#a78bfa', dash: '5 4' })}
    <text class="ras-tag" x="258" y="18" style="fill:#c4b5fd">Severity / Mask 配置（软件写寄存器）</text>

    <!-- 分级输出 → 隔离门 -->
    ${rasFlow(296, 140, 350, 140, { color: ERR, width: 2.6, anim: 2.6 })}
    <g class="arch-link" data-arch="contain" role="button" tabindex="0" aria-label="DPC 隔离门">
      <path class="ras-gate" d="M352,106 L352,174 L384,140 Z"/>
      <path class="ras-gate" d="M416,106 L416,174 L384,140 Z"/>
      <text class="blk-title" x="384" y="192" text-anchor="middle">DPC 隔离</text>
      <text class="ras-sub" x="384" y="205" text-anchor="middle">Egress Control</text>
    </g>
    ${rasFlow(416, 140, 470, 140, { color: ERR, width: 2.4, head: false })}

    <!-- 上报：虚线出边界，交给外部的系统 RAS 处理 / 中断服务程序 -->
    ${rasFlow(470, 138, 470, 60, { color: ERR, width: 2.2, head: false })}
    ${rasFlow(470, 60, 582, 60, { color: EXT, dash: '6 4' })}
    <text class="ras-tag" x="520" y="50" text-anchor="middle" style="fill:#f9a8d4">ERR_* Message</text>
    <g class="arch-link" data-arch="report" role="button" tabindex="0" aria-label="系统 RAS 处理程序">
      <rect class="ras-ext" x="584" y="34" width="126" height="58" rx="10"/>
      <text class="blk-title" x="647" y="54" text-anchor="middle">系统 RAS 处理</text>
      <text class="ras-sub" x="647" y="67" text-anchor="middle">中断服务程序 ISR / 固件</text>
      <text class="ras-sub" x="647" y="80" text-anchor="middle">读 AER 日志 · 定策略</text>
    </g>

    <!-- 恢复：外部处理程序回写设备（虚线） -->
    ${rasFlow(647, 94, 647, 252, { color: REC, dash: '6 4', head: false })}
    ${rasFlow(647, 252, 458, 252, { color: REC, dash: '6 4' })}
    <text class="ras-tag" x="540" y="240" text-anchor="middle" style="fill:#6ee7b7">恢复请求：写寄存器 / 复位</text>
    <g class="arch-link" data-arch="recover" role="button" tabindex="0" aria-label="恢复动作">
      <rect class="ras-tap" x="344" y="228" width="112" height="48" rx="8" style="stroke:${REC}"/>
      <text class="blk-title" x="400" y="247" text-anchor="middle">恢复动作</text>
      <text class="blk-expr" x="400" y="262" text-anchor="middle" style="fill:${REC}">FLR · Hot Reset · 换卡</text>
    </g>

    <text class="ras-sub" x="16" y="296">当前：AER 纠正 ${aer.correctable} · Non-Fatal ${aer.nonfatal} · Fatal ${aer.fatal} · DPC ${dpc.state}</text>

    <!-- 图例 -->
    <line class="ras-flow" x1="12" y1="332" x2="40" y2="332" style="stroke:${ERR};stroke-width:2.2"/>
    <polygon class="ras-head" style="fill:${ERR}" points="40,332 34,329 34,335"/>
    <text class="ras-sub" x="46" y="335">硬件检测 / 数据路径</text>
    <line class="ras-flow" x1="186" y1="332" x2="214" y2="332" style="stroke:${EXT};stroke-width:2.2;stroke-dasharray:6 4"/>
    <polygon class="ras-head" style="fill:${EXT}" points="214,332 208,329 208,335"/>
    <text class="ras-sub" x="220" y="335">软件 / 外部 RAS 处理</text>
  </svg>`;
}

/** RAS 可靠性与可维护性模型：错误检测、分级、上报、隔离与恢复。 */
export function rasModel(ctx) {
  const { aer, dpc } = ctx;
  const activeErr = aer.fatal > 0 ? 2 : aer.nonfatal > 0 ? 1 : aer.correctable > 0 ? 0 : -1;

  return `<div class="model-head">
      <span class="model-badge">RAS · 可靠性 / 可维护性</span>
      AER 纠正 ${aer.correctable} · Non-Fatal ${aer.nonfatal} · Fatal ${aer.fatal} · DPC ${dpc.state}
    </div>

    ${sect('架构', 'PHY / DL / TL 三路探针 → 分级 MUX → DPC 隔离门；实线为硬件路径，虚线为软件 / 外部 RAS 处理 · 点击方块查看细节')}
    ${rasArch(aer, dpc)}

    ${sect('错误分级', 'Correctable 可自愈；Non-Fatal 需软件介入；Fatal 必须复位链路')}
    ${stateTable(['级别', '典型来源', '上报消息', '系统动作'], RAS_ERRORS, activeErr)}
    <p class="hint">分级由 AER Uncorrectable Error Severity 决定；同一错误可被配置为 Non-Fatal 或 Fatal。Poisoned TLP 属于可检测但不可纠正的数据完整性错误。</p>

    ${sect('机制对照', 'AER / DPC / EDR / 热插拔 / FLR 各自解决 RAS 的不同环节')}
    ${stateTable(['机制', '作用', '在 RAS 中的定位'], RAS_MECHS)}

    ${sect('检测层次', '错误在哪一层被发现，决定了它能否被纠正')}
    ${stateTable(['层', '检测手段', '可纠正性'], [
    ['PHY', '8b/10b 或 128b/130b 编码违例、Disparity、Lane 同步丢失', '多数需重训链路（Fatal / 链路级）'],
    ['Data Link', 'LCRC、序列号、Replay Timer、Bad DLLP', 'LCRC 可经 Replay 纠正（Correctable）'],
    ['Transaction', 'ECRC、Malformed TLP、Poisoned TLP、Completion Timeout、UR/CA', '数据完整性错误通常 Non-Fatal'],
    ['链路状态', 'Surprise Down、Receiver Overflow、Training Error', 'Fatal，需要复位或换卡'],
  ])}
    <p class="hint">模型只覆盖 PCIe 基础 RAS（AER / DPC / 热插拔 / 复位）；CXL 的 RAS 能力与 RAS Capability 寄存器不在本模型范围内。DOE、IDE 等安全相关机制见「安全与可信」分组。</p>

    ${sect('数学公式', '错误率、可用性与恢复时间的简化表达')}
    ${formula([
    '残留误码：BER_eff = BER_raw × (1 − 纠错 / 重传覆盖)',
    '可用性：A = MTBF / (MTBF + MTTR)',
    '恢复时间：t_recover = t_detect + t_contain + t_reset + t_retrain',
    'DPC 收益：MTTR ↓（隔离后只恢复受影响端口，不必整机重启）',
  ], `AER 累计：纠正 ${aer.correctable} 次、Non-Fatal ${aer.nonfatal} 次、Fatal ${aer.fatal} 次；DPC 状态 ${dpc.state}。
     恢复动作越“重”（FLR → Hot Reset → 热插拔），t_reset 与 t_retrain 占比越大。`)}

    ${sect('场景对照')}
    <p class="model-assume">「AER 错误上报 + Hot Reset」场景演示检测 → 分级 → ERR_* 上报 → Hot Reset 恢复；
      「DPC · 下游端口隔离 + RP PIO」场景演示隔离 → Egress Control → UR Completion → 软件恢复；
      「LTSSM 电源管理」场景中的热插拔段落对应 PRSNT# → 上电 → PERST# → 训练 → DLLSC。
      模型不模拟具体寄存器位与 ECRC 计算细节，计数与状态直接取自仿真模型。</p>`;
}

/* ---------- Ordering：PCIe 事务排序（PCIe 6.0 Table 2-42） ---------- */

const ORD_HEAD = ['行（后发）\\ 列（先发）', 'Posted Request', 'Read Request', 'NP with Data', 'Completion'];

const ORD_ROWS = [
  ['Posted Request\n（MWr / Message）', ['a) No', 'b) Y/N'], 'Yes', 'Yes', ['a) Y/N', 'b) Yes']],
  ['Read Request\n（MRd / IORd / CfgRd）', ['a) No', 'b) Y/N'], 'Y/N', 'Y/N', 'Y/N'],
  ['NP with Data\n（CfgWr / IOWr / Atomic）', ['a) No', 'b) Y/N'], 'Y/N', 'Y/N', 'Y/N'],
  ['Completion\n（Cpl / CplD）', ['a) No', 'b) Y/N'], 'Yes', 'Yes', ['a) Y/N', 'b) No']],
];

const ORD_EXCEPTIONS = [
  ['RO = 1（Relaxed Ordering）', 'Posted 可超越 Posted；NPR with Data / Completion 可超越 Posted', 'A2b / C2b / D2b'],
  ['IDO = 1（ID-Based Ordering）', 'Requester ID（或 PASID）不同时，请求可超越 Posted', 'A2b / B2b / C2b / D2b'],
  ['同一 Transaction ID 的 Completion', '不得互相超越，保证同一 MRd 的多个 CplD 按地址升序返回', 'D5b'],
  ['I/O / Configuration Write Completion', '允许超越 Posted Request', 'D2b'],
  ['不同 TC', '无任何排序要求，可任意超越；TC 到 VC 的映射必须唯一', '§2.4.1'],
  ['不同 VC', '同一 TC 不允许映射到多个 VC，因此跨 VC 同样无排序约束', '§2.4.1'],
];

const ORD_P_TYPES = new Set(['MWr', 'MSG', 'Msg', 'PM_PME']);
const ORD_NP_TYPES = new Set(['MRd', 'CfgRd0', 'CfgRd1', 'CfgWr0', 'CfgWr1', 'IORd', 'IOWr', 'TR', 'PRQ']);
const ORD_CPL_TYPES = new Set(['Cpl', 'CplD']);

/** PCIe 6.0 Table J-1：9 条摘要规则及其背后的系统需求。 */
const J_RULES = [
  ['P 必须能超越先发的 NP', 'dl'],
  ['P 不得超越先发的 P，除非后发 P 的 RO=1，或 IDO=1 且 Requester ID 不同', 'pc'],
  ['P 可选择超越先发的 Cpl', 'perf'],
  ['Cpl 必须能超越先发的 NP', 'dl'],
  ['Cpl 不得超越先发的 P，除非 Cpl 的 RO=1，或 IDO=1 且 Completer / Requester ID 不同', 'pc'],
  ['不同 Transaction ID 的 Cpl 可选择超越先发的 Cpl', 'perf'],
  ['NP 可选择超越先发的 NP', 'perf'],
  ['NP 可选择超越先发的 Cpl', 'perf'],
  ['NP 不得超越先发的 P，除非 IDO=1 且 Requester ID 不同，或（仅 NP 写）RO=1', 'pc'],
];

const J_REQ = {
  dl: ['Deadlock Avoidance', 'ord-req dl'],
  pc: ['Producer-Consumer Model', 'ord-req pc'],
  perf: ['Performance Optimization', 'ord-req perf'],
};

function ordCounts(sim) {
  const out = { p: 0, np: 0, cpl: 0 };
  if (!sim || !sim.events) return out;
  for (const e of sim.events) {
    if (e.dir !== 'TX') continue;
    if (ORD_P_TYPES.has(e.type)) out.p += 1;
    else if (ORD_NP_TYPES.has(e.type)) out.np += 1;
    else if (ORD_CPL_TYPES.has(e.type)) out.cpl += 1;
  }
  return out;
}

function ordTone(text) {
  const v = String(text).replace(/^[ab]\)\s*/, '');
  if (v === 'Yes') return 'ord-yes';
  if (v === 'No') return 'ord-no';
  return 'ord-opt';
}

function ordCell(v) {
  if (Array.isArray(v)) {
    return `<td class="ord-cell">${v
      .map((t) => `<span class="${ordTone(t)}">${t}</span>`).join('<br>')}</td>`;
  }
  return `<td class="ord-cell ${ordTone(v)}">${v}</td>`;
}

function orderMatrix() {
  const head = ORD_HEAD.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = ORD_ROWS.map(([name, ...cells]) => `<tr>
    <td class="ord-row">${esc(name).replace(/\n/g, '<br>')}</td>${cells.map(ordCell).join('')}</tr>`).join('');
  return `<div class="table-scroll" style="margin-top:8px">
    <table class="compare model-table ord-table">
      <thead><tr>${head}</tr></thead><tbody>${body}</tbody>
    </table>
  </div>`;
}

function orderingSvg() {
  const blk = (x, y, text, color) => `<rect x="${x}" y="${y - 12}" width="90" height="24" rx="6"
      fill="#0c1729" stroke="${color}" stroke-width="1.4"/>
    <text class="ord-blk" x="${x + 45}" y="${y + 3}" text-anchor="middle" style="fill:${color}">${text}</text>`;
  const lane = (y, label, color) => `<text class="ord-lane" x="118" y="${y + 3}" text-anchor="end"
      style="fill:${color}">${label}</text>
    <line x1="126" y1="${y}" x2="700" y2="${y}" stroke="#22314c"/>`;
  const blocked = (fromX, toX, y, label) => `<line x1="${fromX}" y1="${y}" x2="${toX + 7}" y2="${y}"
      stroke="#f87171" stroke-width="1.8" stroke-dasharray="4 3"/>
    <polygon points="${toX},${y} ${toX + 8},${y - 4} ${toX + 8},${y + 4}" fill="#f87171"/>
    <line x1="${(fromX + toX) / 2}" y1="${y - 10}" x2="${(fromX + toX) / 2}" y2="${y + 10}"
      stroke="#f87171" stroke-width="2.2"/>
    <text class="ord-lane" x="${(fromX + toX) / 2}" y="${y - 16}" text-anchor="middle"
      style="fill:#f87171">${label}</text>`;
  return `<svg class="model-svg" viewBox="0 0 720 292" xmlns="http://www.w3.org/2000/svg">
    <line x1="126" y1="32" x2="684" y2="32" stroke="#3b5578"/>
    <polygon points="690,32 682,28 682,36" fill="#3b5578"/>
    <text class="ord-lane" x="700" y="20" text-anchor="end">时间 →</text>

    ${lane(78, 'Posted（P）', '#fbbf24')}
    ${lane(148, 'Non-Posted（NP）', '#38bdf8')}
    ${lane(218, 'Completion（Cpl）', '#34d399')}

    <!-- P → P：后发的 MWr flag 不得超越先发的 MWr data -->
    ${blk(130, 78, 'MWr data', '#fbbf24')}
    ${blk(290, 78, 'MWr flag', '#fbbf24')}
    ${blocked(290, 224, 78, 'P 不得超越 P')}

    <!-- NP 可超越 P：防死锁 -->
    ${blk(130, 148, 'MRd', '#38bdf8')}
    <path d="M222,138 Q238,110 256,94" fill="none" stroke="#34d399" stroke-width="2" stroke-dasharray="5 4"/>
    <polygon points="259,90 248,95 256,102" fill="#34d399"/>
    <text class="ord-lane" x="268" y="120" style="fill:#34d399">NP 可超越 P</text>

    <!-- Cpl 必须能超越 NP；同 TxID 的 Cpl 不得互相超越 -->
    ${blk(130, 218, 'CplD #1', '#34d399')}
    ${blk(290, 218, 'CplD #2', '#34d399')}
    ${blocked(290, 224, 218, '同 TxID 不得超越')}
    <line x1="168" y1="204" x2="168" y2="166" stroke="#34d399" stroke-width="2" stroke-dasharray="5 4"/>
    <polygon points="168,162 163,170 173,170" fill="#34d399"/>
    <text class="ord-lane" x="180" y="184" style="fill:#34d399">Cpl 必须能超越 NP</text>

    <text class="ord-lane" x="126" y="252">绿色虚线 = 必须 / 允许超越（防死锁）；红色禁行条 = 不得超越（强序）</text>
    <text class="ord-lane" x="126" y="270">P→P 强序支撑生产者 / 消费者模型；不同 TC / VC 之间无排序要求</text>
  </svg>`;
}

/** Figure J-1 结构：RC（CPU + RAM dest）↔ Link ↔ EP（Status + Manager + RAM source）。 */
function producerConsumerSvg() {
  const DUR = 24;
  const box = (x, y, w, h, text, color) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"
      fill="#0c1729" stroke="${color}" stroke-width="1.4"/>
    <text class="ord-blk" x="${x + w / 2}" y="${y + h / 2 + 3}" text-anchor="middle" style="fill:${color}">${text}</text>`;
  const pulse = (t0, inner) => `<g opacity="0.4">
    <animate attributeName="opacity" values="0.4;0.4;1;1;0.4"
      keyTimes="0;${t0.toFixed(3)};${(t0 + 0.04).toFixed(3)};0.96;1"
      dur="${DUR}s" repeatCount="indefinite"/>${inner}</g>`;
  // 链路上的小报文框：沿 path 在 [t0,t1] 内移动，其余时间隐藏
  const msg = (text, color, path, t0, t1, w = 46) => {
    const a = t0.toFixed(3);
    const b = (t0 + 0.015).toFixed(3);
    const c = t1.toFixed(3);
    const d = Math.min(0.99, t1 + 0.015).toFixed(3);
    return `<g opacity="0">
      <animate attributeName="opacity" values="0;0;1;1;0;0"
        keyTimes="0;${a};${b};${c};${d};1" dur="${DUR}s" repeatCount="indefinite"/>
      <rect x="${-w / 2}" y="-9" width="${w}" height="18" rx="4" fill="#0c1729" stroke="${color}" stroke-width="1.3"/>
      <text class="ord-blk" x="0" y="3" text-anchor="middle" style="fill:${color}">${text}</text>
      <animateMotion dur="${DUR}s" repeatCount="indefinite" calcMode="linear"
        keyTimes="0;${a};${c};1" keyPoints="0;0;1;1" path="${path}"/>
    </g>`;
  };
  const port = (x, y, color) => `<circle cx="${x}" cy="${y}" r="3.4" fill="#0b1423"
      stroke="${color}" stroke-width="1.8"/>`;
  const comp = (x, y, w, h, title, sub, color) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"
      fill="#0c1729" stroke="${color}" stroke-width="1.5"/>
    <text class="ord-blk" x="${x + w / 2}" y="${y + h / 2 - 2}" text-anchor="middle" style="fill:${color}">${title}</text>
    <text class="ord-lane" x="${x + w / 2}" y="${y + h / 2 + 12}" text-anchor="middle" style="fill:${color}">${sub}</text>`;
  return `<svg class="model-svg" viewBox="0 0 720 460" xmlns="http://www.w3.org/2000/svg">
    <!-- RC / EP 边界 -->
    <rect x="16" y="56" width="276" height="324" rx="12" fill="rgba(30,58,95,0.14)"
      stroke="#2b4162" stroke-dasharray="7 5"/>
    <text class="ord-lane" x="28" y="74" style="fill:#8fb3d9">RC（CPU + RAM + Root Port）</text>
    <rect x="480" y="56" width="224" height="324" rx="12" fill="rgba(30,58,95,0.14)"
      stroke="#2b4162" stroke-dasharray="7 5"/>
    <text class="ord-lane" x="692" y="74" text-anchor="end" style="fill:#8fb3d9">EP（Endpoint）</text>

    <!-- RC：CPU / RAM(dest) / RP -->
    ${pulse(0.64, box(32, 78, 130, 60, 'CPU（Consumer）', '#38bdf8'))}
    ${box(32, 300, 130, 38, 'RAM（dest）', '#fbbf24')}
    ${comp(196, 78, 72, 278, 'RP', 'Root Port', '#a78bfa')}

    <!-- EP：EP 控制器 / Status / Manager / RAM(source) -->
    ${comp(500, 78, 60, 278, 'EP', 'Endpoint', '#a78bfa')}
    <rect x="576" y="86" width="120" height="38" rx="6" fill="#0c1729" stroke="#64748b" stroke-width="1.4">
      <animate attributeName="stroke" values="#64748b;#64748b;#34d399;#34d399;#64748b"
        keyTimes="0;0.64;0.71;0.96;1" dur="${DUR}s" repeatCount="indefinite"/>
    </rect>
    <text class="ord-blk" x="636" y="102" text-anchor="middle" style="fill:#94a3b8">Status Register</text>
    <text class="ord-blk" x="636" y="118" text-anchor="middle" style="fill:#94a3b8">flag = 0
      <animate attributeName="opacity" values="1;1;0;0;1" keyTimes="0;0.64;0.71;0.96;1"
        dur="${DUR}s" repeatCount="indefinite"/>
    </text>
    <text class="ord-blk" x="636" y="118" text-anchor="middle" style="fill:#34d399">flag = 1
      <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.64;0.71;0.96;1"
        dur="${DUR}s" repeatCount="indefinite"/>
    </text>
    ${pulse(0.04, box(576, 176, 120, 40, 'Manager（Producer）', '#fbbf24'))}
    ${box(576, 300, 120, 38, 'RAM（source）', '#94a3b8')}

    <!-- Link：RP ↔ EP -->
    <rect x="268" y="84" width="232" height="260" rx="12" fill="rgba(30,58,95,0.12)"
      stroke="#2b4162" stroke-dasharray="6 4"/>
    <text class="ord-lane" x="376" y="76" text-anchor="middle" style="fill:#8fb3d9">Link（同一链路 · 双向）</text>

    <!-- RX：CPU → RP → EP → Status Register（y=96，端口 22px 间距） -->
    <line x1="162" y1="96" x2="570" y2="96" stroke="#38bdf8" stroke-width="1.6" stroke-dasharray="5 4"/>
    <polygon points="576,96 566,92 566,100" fill="#38bdf8"/>
    ${port(268, 96, '#a78bfa')}${port(500, 96, '#a78bfa')}
    ${msg('NP_S#1', '#38bdf8', 'M162,96 L544,96', 0.10, 0.22, 58)}
    ${msg('NP_S#2', '#38bdf8', 'M162,96 L544,96', 0.74, 0.84, 58)}

    <!-- Status ↔ Manager：读 flag -->
    <line x1="636" y1="124" x2="636" y2="172" stroke="#94a3b8" stroke-width="1.4" stroke-dasharray="3 3"/>
    <polygon points="636,176 632,168 640,168" fill="#94a3b8"/>
    <text class="ord-lane" x="610" y="152" text-anchor="end" style="fill:#94a3b8">读 flag</text>

    <!-- TX：Manager → EP → RP → RAM(dest)，P_D 与 CPL_S 共用 -->
    <path d="M636,216 L636,260 L560,260 L560,319 L500,319" fill="none" stroke="#fbbf24" stroke-width="1.4" stroke-dasharray="4 3"/>
    <line x1="500" y1="319" x2="162" y2="319" stroke="#94a3b8" stroke-width="1.6"/>
    <polygon points="162,319 172,315 172,323" fill="#94a3b8"/>
    ${port(500, 319, '#a78bfa')}${port(268, 319, '#a78bfa')}

    ${msg('P_D1', '#fbbf24', 'M500,319 L162,319', 0.03, 0.17, 40)}
    ${msg('P_D2', '#fbbf24', 'M500,319 L162,319', 0.30, 0.46, 40)}
    ${msg('P_D3', '#fbbf24', 'M500,319 L162,319', 0.46, 0.62, 40)}

    <!-- CPL_S：经 RP 内部上行到 CPU 右侧（与 RX 端口相距 22px） -->
    <path d="M500,319 L286,319 L286,118 L268,118 L196,118 L162,118" fill="none"
      stroke="#34d399" stroke-width="1.4" stroke-dasharray="4 3"/>
    <polygon points="162,118 170,114 170,122" fill="#34d399"/>
    ${port(268, 118, '#34d399')}
    ${msg('CPL#1·f0', '#34d399', 'M500,319 L286,319 L286,118 L268,118 L196,118 L162,118', 0.20, 0.52, 54)}
    ${msg('CPL#2·f1', '#34d399', 'M500,319 L286,319 L286,118 L268,118 L196,118 L162,118', 0.86, 0.99, 54)}

    <!-- 规则：CPL_S 不得越过 P_D -->
    <line x1="352" y1="310" x2="352" y2="328" stroke="#f87171" stroke-width="2.4"/>
    <text class="ord-lane" x="320" y="292" style="fill:#f87171">CPL_S 不得越过 P_D</text>
    <text class="ord-lane" x="300" y="364" style="fill:#7b93b1">P_D / CPL 共用 TX 方向；CPL#1→0，CPL#2→1</text>

    <!-- CPU ↔ RAM(dest)：Consumer 读目的数据 -->
    <line x1="90" y1="300" x2="90" y2="142" stroke="#38bdf8" stroke-width="1.4" stroke-dasharray="4 3"/>
    <polygon points="90,138 86,146 94,146" fill="#38bdf8"/>
    <text class="ord-lane" x="100" y="230" style="fill:#38bdf8">读 dest 数据</text>

    <!-- Manager ← RAM(source)；P_S 置 flag -->
    <line x1="600" y1="300" x2="600" y2="220" stroke="#94a3b8" stroke-width="1.4" stroke-dasharray="3 3"/>
    <polygon points="600,216 596,224 604,224" fill="#94a3b8"/>
    <line x1="660" y1="176" x2="660" y2="128" stroke="#fbbf24" stroke-width="1.6" stroke-dasharray="4 3"/>
    <polygon points="660,124 655,133 665,133" fill="#fbbf24"/>
    ${msg('P_S', '#fbbf24', 'M660,176 L660,126', 0.64, 0.70, 36)}

    <!-- 目的数据缓冲 -->
    <rect x="32" y="344" width="130" height="12" rx="4" fill="rgba(251,191,36,0.06)" stroke="#3a5578"/>
    <rect x="32" y="344" width="0" height="12" rx="4" fill="rgba(251,191,36,0.25)" stroke="#fbbf24">
      <animate attributeName="width" values="0;0;130;130;0" keyTimes="0;0.02;0.64;0.96;1"
        dur="${DUR}s" repeatCount="indefinite"/>
    </rect>
    <text class="ord-lane" x="32" y="372" style="fill:#7b93b1">目的数据缓冲（随 P_D 填充）</text>

    <text class="ord-lane" x="126" y="400">① Manager 读 RAM(source) → P_D #1–#3 经 RP/EP 的同一 TX lane 发往 RAM(dest)，可多个同时在途</text>
    <text class="ord-lane" x="126" y="420">② CPU 轮询 2 次：NP_S#1 早在 P_D 完成前发出 → CPL#1 返回 flag=0；P_S 置 1 后 NP_S#2 → CPL#2（最后）返回 flag=1</text>
    <text class="ord-lane" x="126" y="440">③ CPL 不超越 P_D，可与 P_D 夹杂；无关 CFG 读可置 RO=1，无法保证顺序时改用中断或分离地址</text>
  </svg>`;
}

function jTable() {
  const body = J_RULES.map(([text, tag], i) => `<tr>
    <td>${i + 1}</td><td>${esc(text)}</td>
    <td><span class="${J_REQ[tag][1]}">${J_REQ[tag][0]}</span></td></tr>`).join('');
  return `<div class="table-scroll" style="margin-top:8px">
    <table class="compare model-table j-table">
      <thead><tr><th>No.</th><th>规则（Table J-1 摘要）</th><th>系统需求</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

/** PCIe 事务排序模型：Table 2-42 矩阵、RO / IDO 例外与死锁避免。 */
export function orderingModel(ctx = {}) {
  const c = ordCounts(ctx.sim);
  return `<div class="model-head">
      <span class="model-badge">ORDERING · 事务排序</span>
      同一 TC 内：Posted ${c.p} · Non-Posted ${c.np} · Completion ${c.cpl}
    </div>

    ${sect('规则矩阵', 'PCIe 6.0 Table 2-42：行是后发事务、列是先发事务；只在同一 TC 内适用')}
    ${orderMatrix()}
    <p class="hint">Yes = 行必须能超越列（否则可能死锁）；Y/N = 无要求（可超越也可被阻塞）；No = 不得超越（生产者 / 消费者强序）。<br>
      a) 默认规则，b) RO / IDO 等例外条款。</p>

    ${sect('例外与边界', 'RO / IDO / 同一 TxID / 跨 TC · VC')}
    ${stateTable(['属性 / 条件', '作用', '条款'], ORD_EXCEPTIONS)}

    ${sect('直观模型', '三条队列之间的超越关系：绿色虚线表示允许 / 必须超越，红色禁行条表示不得超越')}
    ${demo(orderingSvg(), '箭头方向即“后发事务试图超越先发事务”；标注直接写在该路径旁边，与 Table 2-42 的单元一一对应。', [
    '<i class="sw amber"></i>Posted：MWr / Message，默认保持先后（RO / IDO 例外）。',
    '<i class="sw blue"></i>Non-Posted：MRd / CfgRd 等，可被 Completion 超越；能超越 Posted 是防死锁的前提。',
    '<i class="sw green"></i>Completion：必须能超越 Non-Posted；同一 TxID 之间保持顺序。',
    '跨 TC / VC 无排序要求，软件需用屏障或同一 TC 来保证顺序。',
  ])}

    ${sect('生产-消费者模型', 'PCIe 6.0 Figure J-1：Posted 数据与 Completion 之间的强序')}
    ${demo(producerConsumerSvg(), 'Figure J-1 结构：RC（CPU + RAM dest + RP）↔ EP（EP 控制器 + Status + Manager + RAM source）；24 秒慢放，CPL#1 夹在 P_D1 与 P_D2 之间，CPL 不超越 P_D，最后一次 CPL#2 携带 flag=1。', [
    '<i class="sw amber"></i>P_D：Posted 数据写，按顺序到达目的 RAM。',
    '<i class="sw blue"></i>NP_S：CPU 轮询状态寄存器（本例轮询 2 次：NP_S#1 / NP_S#2）。',
    '<i class="sw green"></i>CPL：状态读的完成；不越过已发出的 P_D，可夹杂其间，最后一次 CPL#2 返回 flag=1。',
    '无关流量（如配置读）可置 RO=1 允许超越；队列无法保证顺序时，改用中断或分离地址。',
  ])}
    <p class="hint">该强序只在同一 TC 内约束“生产者 → 消费者”序列；其他 P / Cpl 可置 RO=1、IDO=1 或使用不同 TC 摆脱约束。
      若某组件（如 RC 的 CPL 接收队列）绕过排序，必须用中断或把数据与 flag 放在不同地址来保证正确性。</p>

    ${sect('规则摘要', 'PCIe 6.0 Table J-1：9 条摘要规则及其背后的系统需求')}
    ${jTable()}
    <p class="hint">Deadlock Avoidance = 必须能超越；Producer-Consumer Model = 不得超越（强序）；Performance Optimization = 可选超越。</p>

    ${sect('形式化表示', '把排序规则写成偏序与可超越关系')}
    ${formula([
    'pass(row, col) ∈ {必须超越, 可超越, 不得超越}',
    '同一 TC：定义偏序 ≺_TC；TC₁ ≠ TC₂ ⇒ 无约束',
    '死锁避免：pass(NP, P) 与 pass(Cpl, NP) 不能同时为“不得超越”',
    '生产者 / 消费者：W(data) ≺ W(flag) 由 P→P 强序保证',
  ], '当前场景的 TLP 计数只统计发送方向（TX），用于对照三类事务；排序规则本身不改变仿真事件顺序。')}

    ${sect('与场景的对应')}
    <p class="model-assume">「内存写」场景是 Posted 请求，「内存读」场景是 Non-Posted 请求 + Completion，
      「设备枚举」场景包含 CfgRd（Read Request）与 CfgWr（NP with Data）。
      模型只解释排序规则与属性，不建模 VC 仲裁、Switch 内部队列深度与 Completion 合并；
      RO / IDO / PASID 的厂商实现差异不在展开范围内。</p>`;
}

/* ---------- DOE：数据对象交换（PCIe 6.2 §6.30） ---------- */

const DOE_REGS = [
  ['+00h', 'Capability Header'],
  ['+04h', 'Capabilities'],
  ['+08h', 'Control'],
  ['+0Ch', 'Status'],
  ['+10h', 'Write Data Mailbox'],
  ['+14h', 'Read Data Mailbox'],
];

const DOE_OBJECTS = [
  ['0001h / 00h', 'DOE Discovery', '必须实现；Index 00h 返回自身', '软件枚举本实例支持的类型'],
  ['0001h / 01h', 'CMA-SPDM', '承载 SPDM 消息', '设备身份认证与度量'],
  ['0001h / 02h', 'Secured CMA-SPDM', '承载 SPDM 安全会话', 'IDE_KM 等密钥管理的传输层'],
  ['0001h / 03h', 'CMA/SPDM + Connection ID', '多软件实体共享一个 DOE 实例', '第 4 DW 给出最大 Connection ID'],
  ['0001h / 04h', 'Secured CMA/SPDM + Connection ID', '安全会话 + Connection ID', '需同时支持 01h / 03h'],
  ['0001h / 05h', 'Async Message', '设备异步发起的数据对象', '第 4 DW 必选'],
];

const DOE_RULES = [
  ['完成时限', 'Go=1 后 1 s 内 Ready=1；否则 Error=1', '超时视为失败，软件可写 Abort 收尾'],
  ['中止', 'Control.Abort=1 → 清 Ready / Error（≤1 s）', 'Abort 是软件唯一的清错手段'],
  ['传输互斥', '一个数据对象传完前不得开始下一个', '多个 feature 需软件串行化'],
  ['FLR', 'FLR 中止进行中的传输；期间写邮箱丢弃、读邮箱 UR 或全 0', '复位后允许置 Error'],
  ['访问粒度', '邮箱读写必须全字节使能，每次 1 DW', '非全字节使能行为未定义'],
  ['P2P', 'DOE 依赖配置请求，不能直接用于 Function 间对等操作', '需要系统软件中继'],
  ['中断', '可选 MSI / MSI-X，不支持 INTx', 'Ready / Error 由 0 变 1 时触发'],
];

function doeChip(x, y, w, h, title, sub) {
  return `<g class="arch-link" data-arch="doe-feature" role="button" tabindex="0" aria-label="${title}">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#0c1729" stroke="#3a5578"/>
    <text class="blk-title" x="${x + w / 2}" y="${y + 17}" text-anchor="middle">${title}</text>
    <text class="blk-expr" x="${x + w / 2}" y="${y + 32}" text-anchor="middle">${sub}</text>
  </g>`;
}

function doeArch() {
  const regY = 44;
  const regH = 168;
  const rows = DOE_REGS.map(([off, name], i) => {
    const yy = regY + 46 + i * 20;
    return `<line x1="198" y1="${yy - 13}" x2="360" y2="${yy - 13}" stroke="#22314c"/>
      <text class="blk-expr" x="200" y="${yy}" style="fill:#7b93b1">${off}</text>
      <text class="blk-title" x="238" y="${yy}" style="font-size:8px">${name}</text>`;
  }).join('');
  return `<svg class="model-svg" viewBox="0 0 720 300" xmlns="http://www.w3.org/2000/svg">
    <rect x="170" y="26" width="536" height="224" rx="14" fill="rgba(30,58,95,0.12)"
      stroke="#2b4162" stroke-dasharray="7 5"/>
    <text class="arch-note" x="180" y="42">设备 / Function（DOE 位于配置空间）</text>

    ${archBlock(12, 86, 144, 84, '系统固件 / 软件', 'CfgRd / CfgWr', '每次 1 DW', '', 'doe-sw')}
    ${archArrow(156, 186, 128, '', 'doe-cfg')}

    <g class="arch-link" data-arch="doe-regs" role="button" tabindex="0" aria-label="DOE 扩展能力寄存器">
      <rect x="190" y="${regY}" width="180" height="${regH}" rx="9" fill="#0c1729" stroke="#3a5578"/>
      <text class="blk-title" x="280" y="${regY + 20}" text-anchor="middle">DOE 扩展能力</text>
      <text class="blk-expr" x="280" y="${regY + 34}" text-anchor="middle">6 个 32-bit 寄存器</text>
      ${rows}
    </g>
    <text class="arch-label" x="196" y="${regY + regH + 16}" style="fill:#7b93b1">Go / Abort 在 +08h，Busy / Ready / Error 在 +0Ch</text>

    ${archArrow(370, 402, 128, 'DO', 'doe-object')}

    ${archBlock(404, 56, 168, 78, 'DOE 实例', '按 Vendor ID + Type 分发', '2 DW … 2^18 DW', 'hot', 'doe-engine')}
    ${doeChip(404, 146, 80, 44, 'Discovery', '00h · 必选')}
    ${doeChip(492, 146, 80, 44, 'CMA-SPDM', '01h / 02h')}
    ${doeChip(404, 194, 80, 44, 'Secured', '会话 / 密钥')}
    ${doeChip(492, 194, 80, 44, 'IDE_KM', '经安全会话')}

    ${archArrow(574, 618, 128, '', 'doe-io')}
    ${archBlock(620, 86, 84, 84, 'Function', '度量 / 密钥', '特性实现', '', 'doe-consumer')}

    <text class="arch-note" x="12" y="266">DOE 不产生 TLP：数据对象通过配置读写搬运，因此带宽低、逐 DW 往返，也不能直接做 Function 间 P2P。</text>
    <text class="arch-note" x="12" y="284">Discovery 负责枚举；CMA-SPDM / IDE_KM 负责认证与密钥；Async Message 允许设备主动上报。</text>
  </svg>`;
}

function doeFlowSvg() {
  const SW = 120;
  const DEV = 500;
  const msg = (y, t0, toDev, color, label) => {
    const a = t0.toFixed(3);
    const b = (t0 + 0.015).toFixed(3);
    const c = (t0 + 0.10).toFixed(3);
    const d = (t0 + 0.115).toFixed(3);
    const path = toDev ? `M${SW},${y} L${DEV},${y}` : `M${DEV},${y} L${SW},${y}`;
    return `${label ? `<text class="arch-label" x="${(SW + DEV) / 2}" y="${y - 7}" text-anchor="middle">${label}</text>` : ''}
      <g opacity="0">
      <animate attributeName="opacity" values="0;0;1;1;0;0"
        keyTimes="0;${a};${b};${c};${d};1" dur="10s" repeatCount="indefinite"/>
      <circle r="3" fill="${color}"><animateMotion dur="10s" repeatCount="indefinite" calcMode="linear"
        keyTimes="0;${a};${c};1" keyPoints="0;0;1;1" path="${path}"/></circle>
    </g>`;
  };
  const arrow = (y, color, toDev = true) => {
    const tip = toDev ? DEV : SW;
    const dir = toDev ? 1 : -1;
    return `<line x1="${SW}" y1="${y}" x2="${DEV}" y2="${y}" stroke="${color}" stroke-width="1.3"/>
      <polygon points="${tip},${y} ${tip - 7 * dir},${y - 3.5} ${tip - 7 * dir},${y + 3.5}" fill="${color}"/>`;
  };
  return `<svg class="model-svg" viewBox="0 0 720 270" xmlns="http://www.w3.org/2000/svg">
    <line x1="${SW}" y1="46" x2="${SW}" y2="226" stroke="#22314c" stroke-dasharray="4 4"/>
    <line x1="${DEV}" y1="46" x2="${DEV}" y2="226" stroke="#22314c" stroke-dasharray="4 4"/>
    <rect x="${SW - 72}" y="24" width="144" height="22" rx="6" fill="#0c1729" stroke="#3a5578"/>
    <text class="blk-title" x="${SW}" y="39" text-anchor="middle">系统固件 / 软件</text>
    <rect x="${DEV - 40}" y="24" width="80" height="22" rx="6" fill="#0c1729" stroke="#3a5578"/>
    <text class="blk-title" x="${DEV}" y="39" text-anchor="middle">DOE 实例</text>
    <text class="arch-label" x="20" y="140" style="fill:#7b93b1">时间 ↓</text>

    ${arrow(64, '#38bdf8')}${msg(64, 0.02, true, '#38bdf8', '① CfgWr DW0…DWn → Write Data Mailbox')}
    ${arrow(94, '#38bdf8')}${msg(94, 0.13, true, '#38bdf8', '② CfgWr Control.Go = 1')}
    <rect x="430" y="108" width="140" height="24" rx="6" fill="rgba(251,191,36,0.08)" stroke="#fbbf24"/>
    <text class="arch-label" x="500" y="124" text-anchor="middle" style="fill:#fbbf24">③ Busy=1 · 解析 / 执行特性</text>
    ${arrow(154, '#34d399', false)}${msg(154, 0.34, false, '#34d399', '④ Status.Ready=1（≤1 s，否则 Error=1）')}
    ${arrow(184, '#38bdf8')}${msg(184, 0.50, true, '#38bdf8', '⑤ CfgRd Read Data Mailbox ×N')}
    ${arrow(214, '#38bdf8')}${msg(214, 0.72, true, '#38bdf8', '⑥ 回写 Read Mailbox 确认 → 清 Ready')}

    <text class="arch-note" x="12" y="246">可选：Ready / Error 由 0 变 1 触发 MSI/MSI-X；任意时刻写 Abort=1 可在 1 s 内中止并清 Ready / Error。</text>
    <text class="arch-note" x="12" y="264">Discovery 是唯一必选特性：软件按 Index 递增查询，直到 Next Index = 00h 为止。</text>
  </svg>`;
}

/** DOE 数据对象交换模型：配置空间邮箱 + 请求/响应数据对象。 */
export function doeModel(ctx = {}) {
  const link = ctx.link || {};
  const gen = link.gen ?? 4;
  const width = link.width ?? 8;
  return `<div class="model-head">
      <span class="model-badge">DOE · 数据对象交换</span>
      Gen${gen} ×${width} · 走配置请求 · 每个数据对象 2 DW 起
    </div>

    ${sect('架构', '软件通过配置读写访问邮箱；DOE 实例按 Vendor ID + Type 把数据对象交给对应特性 · 点击方块查看细节')}
    ${doeArch()}

    ${sect('邮箱寄存器', 'DOE 扩展能力固定 24 B，数据靠两个邮箱逐 DW 搬运')}
    ${stateTable(['偏移', '寄存器', '作用'], [
    ['+00h', 'Capability Header', '扩展能力 ID、版本、Next Capability'],
    ['+04h', 'Capabilities', 'Capability Version、Interrupt Support、中断向量号'],
    ['+08h', 'Control', 'DOE Go（启动）、Abort（中止）、Interrupt Enable、Attention'],
    ['+0Ch', 'Status', 'DOE Busy、Data Object Ready、DOE Error、Interrupt Status'],
    ['+10h', 'Write Data Mailbox', '每写 1 DW 拼入一个数据对象；读完即清'],
    ['+14h', 'Read Data Mailbox', '每读 1 DW；读完最后 1 DW 后回写一次作为确认'],
  ])}
    <p class="hint">邮箱只支持 32-bit 全字节使能访问；一次数据对象传输就是 N 次配置写 + N 次配置读，天然是低带宽、高往返开销的路径。</p>

    ${sect('数据对象格式', 'DW0 说明「谁定义的、什么类型」，DW1 给出长度与 Connection ID')}
    ${stateTable(['字段', '位置', '含义'], [
    ['Vendor ID', 'DW0 [15:0]', '定义该数据对象类型的厂商；PCI-SIG 为 0001h'],
    ['Data Object Type', 'DW0 [23:16]', '类型编号，由 Vendor ID 对应的厂商定义'],
    ['Length', 'DW1 [17:0]', '以 DW 计，含头部 2 DW；0002h = 2 DW，0000h = 2^18 DW，0001h 非法'],
    ['Connection ID', 'DW1 [29:18]', '仅使用 Connection ID 的类型有效，其余保留'],
  ])}

    ${sect('PCI-SIG 数据对象类型', 'Vendor ID = 0001h')}
    ${stateTable(['ID', '名称', '说明', '典型用途'], DOE_OBJECTS)}
    <p class="hint">长度不匹配、长度过短或类型不支持时，整个数据对象被静默丢弃；长度偏长则只处理期望部分。Discovery 必须在索引 00h 出现，索引无效时返回 Vendor ID = FFFFh。</p>

    ${sect('动态演示', '一次请求 / 响应：写邮箱 → Go → Ready → 读邮箱 → 回写确认')}
    ${demo(doeFlowSvg(), '往返全部走配置请求，每一步都对应一次 Non-Posted 配置访问；设备侧处理超过 1 s 会置 Error 而不是 Ready。', [
    '<i class="sw blue"></i>写：软件逐 DW 填 Write Data Mailbox，最后一次写 Control.Go=1。',
    '<i class="sw amber"></i>处理：Busy=1，DOE 实例解析头部并交给特性实现；期间软件不应再写邮箱。',
    '<i class="sw green"></i>读：Ready=1 后逐 DW 读 Read Data Mailbox，读完回写一次让实例清 Ready。',
    '超时或错误：Error=1，必须由软件写 Abort=1 清除；FLR 也会中止进行中的传输。',
  ])}

    ${sect('协议约束', '时限、互斥、复位与拓扑限制')}
    ${stateTable(['约束', '规则', '后果'], DOE_RULES)}

    ${sect('数学公式', '把邮箱访问看成逐 DW 的往返，而不是突发传输')}
    ${formula([
    't_DO ≈ N_DW × t_CfgWr + t_proc + N_DW × t_CfgRd',
    't_CfgWr ≈ t_TLP + t_Completion（Non-Posted，逐 DW 串行）',
    '完成条件：t_proc ≤ 1 s，否则 Status.Error = 1',
    '有效吞吐 ≈ 4 B / (t_CfgWr + t_CfgRd) ≪ 链路带宽',
  ], `当前链路 Gen${gen} ×${width}：数据对象大小由 Length 决定，2 DW 到 2^18 DW。
     DOE 的价值在「可达性与标准化」，不在吞吐；大对象应交给普通内存 TLP。`)}

    ${sect('与场景的对应')}
    <p class="model-assume">DOE 复用「设备枚举」场景里的配置请求通路，是枚举完成后由固件 / 驱动发起的带内管理通道。
      本模拟器目前没有实现 DOE 邮箱寄存器与 SPDM 会话，也没有重放 DOE 事件；模型只做协议级讲解，
      不表示数据对象会出现在时间轴或事件日志里。DOE 也不能替代 TLP 数据通路。</p>`;
}

/* ---------- IDE：完整性与数据加密（PCIe 6.2 §6.33，TDISP 第 11 章） ---------- */

const IDE_FIELDS = [
  ['Byte 0 [7:4]', 'Fmt = 1001b', '端到端 TLP Prefix'],
  ['Byte 0 [3:0]', 'Type = 0010b', '标识 IDE Prefix'],
  ['Byte 1 [7:0]', 'PR_Sent_Counter', '非 UIO Non-Posted 请求 / 完成的重放计数；Posted 保留'],
  ['Byte 2 [7:0]', 'Stream_ID', 'IDE 流标识'],
  ['Byte 3 [7:4]', 'Sub-Stream[3:0]', '0000 Posted / 0001 Non-Posted / 0010 Completion / 0111 非 IDE 的 OHC-C'],
  ['Byte 3 [3]', 'P', '含 PCRC；仅当 M=1 才可置位'],
  ['Byte 3 [2]', 'M', '含 MAC；不聚合时必须为 1'],
  ['Byte 3 [1]', 'K', '密钥集：K0 / K1'],
  ['Byte 3 [0]', 'T', 'TLP 源自 TEE / TVM（TDISP 使用）'],
];

const IDE_CAP_STRUCT = [
  ['+00h', 'Extended Capability Header', 'Capability ID = 0030h，Capability Version = 1h'],
  ['+04h', 'IDE Capability Register', 'Link / Selective / Flow-Through 能力、算法、TC 数与流数'],
  ['+08h', 'IDE Control Register', 'bit2 = Flow-Through IDE Stream Enabled'],
  ['Link 块 ×0–8', 'Link IDE Stream Control + Status', '每个 TC 一个块（最多 8 个）'],
  ['Selective 块 ×0–255', 'Capability + Control + Status + RID / Address Association', '每个流一个块，最多 256 个'],
  ['RID 关联', 'Association Register 1 / 2', 'RID Limit / RID Base，Register 2 的 bit0 为 V'],
  ['地址关联', 'Association Register 1–3', 'Memory Base / Limit，Register 1 的 bit0 为 V'],
];

const IDE_CAP_BITS = [
  ['0', 'Link IDE Stream Supported', '存在 Link IDE 块'],
  ['1', 'Selective IDE Streams Supported', '存在 Selective IDE 块'],
  ['2', 'Flow-Through IDE Stream Supported', 'Switch / Root Port 可透传 Selective 流'],
  ['4', 'Aggregation Supported', '支持 TLP 聚合'],
  ['5', 'PCRC Supported', '支持明文 CRC'],
  ['6', 'IDE_KM Protocol Supported', '支持 IDE_KM 响应者角色'],
  ['7', 'Selective IDE for CfgReq Supported', '配置请求也可关联 Selective 流'],
  ['12:8', 'Supported Algorithms', '00000b = AES-GCM 256 密钥 / 96 b MAC'],
  ['15:13', 'Number of TCs Supported for Link IDE', '000b = 1 个 TC … 111b = 8 个 TC'],
  ['23:16', 'Number of Selective IDE Streams Supported', '0 = 1 条流 … 255 = 256 条流'],
];

const IDE_STREAM_CTRL = [
  ['0', 'Stream Enable', '置 1 后由 IDE_KM 触发；清 0 立即回 Insecure'],
  ['3:2 / 5:4 / 7:6', 'Tx Aggregation Mode NPR / PR / CPL', '00 不聚合 … 11 最多 8 个'],
  ['8', 'PCRC Enable', '含载荷的发送 TLP 必须带 PCRC'],
  ['9', 'Selective IDE for CfgReq Enable', '仅 Root Port 有效'],
  ['18:14', 'Selected Algorithm', '00000b = AES-GCM 256 / 96 b'],
  ['21:19', 'TC', '该流关联的 Traffic Class'],
  ['22', 'Default Stream', '仅 EP Upstream Port；同一 TC 只能一个'],
  ['23', 'TEE-Limited Stream', 'TDISP 增补：该流只允许 T=1 的 TLP'],
  ['31:24', 'Stream ID', '两个 Partner 端口必须一致'],
  ['Status 3:0', 'Stream State', '0000 = Insecure，0010 = Secure'],
  ['Status 31', 'Received Integrity Check Fail Message', 'RW1C；收到完整性检查失败消息'],
];

const IDE_KM_OBJS = [
  ['00h', 'QUERY', 'Req → Resp', '查询 PortIndex 对应端口的能力与配置'],
  ['01h', 'QUERY_RESP', 'Resp → Req', 'PortIndex / MaxPortIndex / Bus / Segment / DevFn + IDE 能力结构'],
  ['02h', 'KEY_PROG', 'Req → Resp', 'PortIndex + Stream ID + 子流 + RxTxB + Key Set + 256 b Key + 64 b IFV'],
  ['03h', 'KP_ACK', 'Resp → Req', 'Status：00 成功 / 01 长度错 / 02 PortIndex 不支持 / 03 字段不支持 / 04 失败'],
  ['04h', 'K_SET_GO', 'Req → Resp', '启用指定 Key Set；接收端必须先于发送端'],
  ['05h', 'K_SET_STOP', 'Req → Resp', '停用并销毁指定 Key Set'],
  ['06h', 'K_GOSTOP_ACK', 'Resp → Req', '确认可以接收下一条 IDE_KM 请求'],
];

const IDE_KM_RULES = [
  ['传输', '必须放在 Secured-SPDM 会话内；未安全传输的数据对象丢弃且不得响应'],
  ['Object ID', 'DW0 bits[7:0] = Protocol ID 00h（IDE）；bits[15:8] = Object ID 00h–06h'],
  ['PortIndex', '00h = 本端口；01h–FFh = 该端口代表的其它端口'],
  ['密钥', '256 b；每个 Sub-Stream × 方向独立；一条流共 6 把'],
  ['Key Set', 'K0 / K1 两套；初始建议 K=0；切换后旧 bank 失效直到重新编程'],
  ['时限', 'KP_ACK ≤1 s；K_SET_GO 后 10 ms 内开始用新键 / 可收新键；K_SET_STOP 10 ms 内销毁'],
  ['会话绑定', '同一条流的密钥必须由同一个 SPDM 会话编程；换会话须先销毁旧密钥并转 Insecure'],
  ['顺序', '先给两个 Partner 端口的接收端发 K_SET_GO，再给发送端发 K_SET_GO'],
  ['DOE 触发', '触发 IDE 的配置写先用非 IDE Completion 返回，再启动 IDE'],
];

const IDE_STREAMS = [
  ['Link IDE', '一条链路上某个 TC 的全部 TLP（Selective 关联的除外）', '无 Switch，或逐跳全部启用', '直连 RC ↔ EP'],
  ['Selective IDE', '按 Stream_ID / 地址等规则选定的 TLP', '可跨 Switch 逐跳建立，也可 EP ↔ EP', 'TDISP / P2P / 多租户'],
  ['Flow-Through Selective', 'Switch 只转发、不改写选定流', '跨 Switch 端到端', '把中间 Switch 排除出 TCB'],
];

const IDE_STATES = [
  ['Insecure', '流未建立，或检测到危及安全的条件', '端口必须阻止「本应加密」的 TLP 发出'],
  ['Ready', '配置完成、密钥已就绪（软件可见的概念子状态）', '硬件不跟踪，由系统软件判定'],
  ['Secure', 'Enable=1 且密钥、校验均正常', '正常收发 IDE TLP'],
  ['TEE Not Locked', '任一必需 IDE 流不在 Secure', 'TDISP 禁止 TDI 进入 RUN'],
  ['TEE Locked', '所有必需 IDE 流均为 Secure', '允许 TEE 访问设备接口'],
];

const IDE_ERRORS = [
  ['IDE Check Failed', 'MAC 校验失败、K 位 / 子流 / 序列等规则违例', '丢弃 TLP 并报错（AER 可选状态位）'],
  ['PCRC Check Failed', '解密后明文 CRC 不符，说明加解密逻辑出错', 'Non-Fatal；数据不应继续使用'],
  ['Misrouted IDE TLP', '流未使能、两端 Flit / Non-Flit 不一致或路由错误', '不转发、不产生 Completion'],
];

function ideDashed(x1, y1, x2, y2, color = '#a78bfa') {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}"
    stroke-width="1.3" stroke-dasharray="4 4"/>`;
}

function ideArch(link) {
  const gen = link.gen ?? 4;
  const width = link.width ?? 8;
  const flit = link.flitMode ? 'FM · OHC-C + Trailer' : 'NFM · IDE Prefix';
  return `<svg class="model-svg" viewBox="0 0 720 310" xmlns="http://www.w3.org/2000/svg">
    <!-- 数据平面 -->
    ${archBlock(12, 42, 100, 84, 'TL 明文 TLP', 'Header + Data', 'A / P', '', 'ide-plain')}
    ${archArrow(112, 140, 84, '', 'ide-in')}
    ${archBlock(142, 42, 110, 84, 'IDE TX 引擎', 'AES-GCM', '加密 + 认证', 'hot', 'ide-gcm')}
    ${archArrow(252, 280, 84, '', 'ide-enc')}
    ${archBlock(282, 42, 118, 84, '线上 IDE TLP', flit, '4 B + 12 B', '', 'ide-wire')}
    ${archArrow(400, 436, 84, '', 'ide-link')}
    ${archBlock(438, 42, 96, 84, '物理链路', 'Retimer / Switch', '攻击面', '', 'ide-link2')}
    ${archArrow(534, 566, 84, '', 'ide-rx')}
    ${archBlock(568, 42, 140, 84, 'IDE RX 引擎', '校验 MAC → 解密', '失败即丢弃', '', 'ide-rx')}
    <text class="arch-note" x="12" y="140">数据平面：明文 TLP → AES-GCM 加密 → 线上（前缀 + 密文 + MAC）→ 对端校验并解密</text>

    <!-- 控制平面 -->
    <rect x="6" y="160" width="708" height="100" rx="12" fill="rgba(167,139,250,0.05)"
      stroke="#3b3358" stroke-dasharray="6 4"/>
    <text class="arch-note" x="16" y="176">控制平面：配置 IDE Cap / Stream Control → 认证 → 安全会话 → 密钥管理 → 启用流（虚线 = 配置 / 密钥，不是数据）</text>
    ${archBlock(12, 184, 132, 66, '系统固件 / 软件', '配置 IDE Cap / 流', '中央权威', '', 'ide-ctrl')}
    ${archArrow(144, 176, 217, '', 'ide-spdm')}
    ${archBlock(178, 184, 148, 66, 'DOE + CMA-SPDM', '认证 / 安全会话', '01h / 02h', '', 'ide-spdm2')}
    ${archArrow(326, 358, 217, '', 'ide-km')}
    ${archBlock(360, 184, 150, 66, 'IDE_KM', 'KEY_PROG / K_SET_GO', 'K_SET_STOP / ACK', 'hot', 'ide-km2')}
    ${archArrow(510, 542, 217, '', 'ide-keys')}
    ${archBlock(544, 184, 164, 66, '密钥库', '256 b × 3 子流 × Rx/Tx', 'K 位选择 bank', '', 'ide-keys2')}

    ${ideDashed(626, 184, 640, 140, '#a78bfa')}
    ${ideDashed(600, 184, 600, 140, '#a78bfa')}
    <text class="arch-label" x="652" y="152" text-anchor="end" style="fill:#c4b5fd">编程密钥 / 启停流</text>

    <text class="arch-note" x="10" y="278">当前配置：Gen${gen} ×${width} · ${flit}</text>
    <text class="arch-note" x="10" y="296">IDE 只保护两个 IDE 端点之间的链路；端口以内（片上）的隔离由 TEE / TDISP 负责，不在 IDE 范围内。</text>
  </svg>`;
}

function ideTlpSvg() {
  const box = (x, y, w, h, title, sub, color, key = '') => `<g class="arch-link"${key ? ` data-arch="${key}" role="button" tabindex="0"` : ''}>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="#0c1729" stroke="${color}"/>
    <text class="blk-title" x="${x + w / 2}" y="${y + 17}" text-anchor="middle">${title}</text>
    <text class="blk-expr" x="${x + w / 2}" y="${y + 31}" text-anchor="middle" style="fill:${color}">${sub}</text>
  </g>`;
  return `<svg class="model-svg" viewBox="0 0 720 270" xmlns="http://www.w3.org/2000/svg">
    <text class="arch-label" x="20" y="26" style="fill:#7b93b1">线上 IDE TLP（Non-Flit Mode）</text>
    ${box(20, 38, 92, 44, 'IDE Prefix', '4 B', '#38bdf8', 'ide-prefix')}
    ${box(116, 38, 148, 44, 'Header（A）', '认证不加密', '#a78bfa', 'ide-header')}
    ${box(268, 38, 210, 44, 'Data Payload → C', 'AES-GCM 加密', '#fbbf24', 'ide-payload')}
    ${box(482, 38, 62, 44, 'PCRC', '可选 4 B', '#94a3b8')}
    ${box(548, 38, 100, 44, 'MAC', '96 b = 12 B', '#34d399', 'ide-mac')}

    <line x1="20" y1="94" x2="264" y2="94" stroke="#a78bfa" stroke-width="1.2"/>
    <text class="arch-label" x="20" y="108" style="fill:#c4b5fd">A = Prefix ‖ Header（参与认证，不加密）</text>
    <line x1="268" y1="94" x2="478" y2="94" stroke="#fbbf24" stroke-width="1.2"/>
    <text class="arch-label" x="268" y="108" style="fill:#fbbf24">P → C（加密）；MAC 覆盖 A 与 C</text>

    <rect x="96" y="136" width="250" height="64" rx="9" fill="#0c1729" stroke="#3a5578"/>
    <text class="blk-title" x="221" y="156" text-anchor="middle">AES-GCM(K, IV)</text>
    <text class="blk-expr" x="221" y="172" text-anchor="middle">A → GHASH；P → CTR 加密</text>
    <text class="blk-val" x="221" y="188" text-anchor="middle">输出 C + 96 b MAC</text>
    <line x1="221" y1="112" x2="221" y2="132" stroke="#7dd3fc" stroke-width="1.3"/>
    <polygon points="221,136 217,128 225,128" fill="#7dd3fc"/>
    <text class="arch-label" x="230" y="126" style="fill:#7dd3fc">A + P</text>
    ${archArrow(346, 392, 168, 'C + MAC', 'ide-out')}

    <rect x="398" y="136" width="136" height="64" rx="9" fill="#0c1729" stroke="#34d399"/>
    <text class="blk-title" x="466" y="156" text-anchor="middle">对端校验</text>
    <text class="blk-expr" x="466" y="172" text-anchor="middle" style="fill:#34d399">MAC 一致 → 解密交付</text>
    <text class="blk-expr" x="466" y="188" text-anchor="middle" style="fill:#f87171">MAC 不符 → 丢弃 + 报错</text>

    <g opacity="0.4">
      <animate attributeName="opacity" values="0.25;0.25;1;1;0.25" keyTimes="0;0.35;0.42;0.72;0.8"
        dur="9s" repeatCount="indefinite"/>
      <text class="arch-label" x="556" y="122" style="fill:#f87171">攻击：改 1 bit / 删 TLP / 重排</text>
      <line x1="556" y1="128" x2="532" y2="140" stroke="#f87171" stroke-width="1.6" stroke-dasharray="4 3"/>
      <polygon points="530,141 538,134 540,142" fill="#f87171"/>
    </g>

    <text class="arch-note" x="20" y="228">每个 TLP 固定开销 = 4 B 前缀（FM 为 OHC-C）+ 12 B MAC；PCRC 另加 4 B。MAC 计入 Header Credit，不占 Data Credit。</text>
    <text class="arch-note" x="20" y="246">聚合 n 个 TLP 时 MAC 只算一次：开销 ≈ 4 + 12/n 字节/TLP，规范建议约 4 个一组。</text>
    <text class="arch-note" x="20" y="264">部分包头加密可把地址与字节使能移入 P，降低侧信道暴露，但路由所需字段仍保持明文。</text>
  </svg>`;
}

/** IDE Prefix（NFM）逐字节 / 逐位布局：1 DW = 4 B。 */
function idePrefixSvg() {
  const BX = [56, 206, 356, 506];
  const CW = 17;
  const cell = (x, y, color) => `<rect x="${x}" y="${y}" width="${CW - 1}" height="28" rx="2"
    fill="#0c1729" stroke="${color}"/>`;
  const bits = (x, y, n) => Array.from({ length: n }, (_, i) => `<text class="blk-val"
    x="${x + i * CW + (CW - 1) / 2}" y="${y - 5}" text-anchor="middle">${7 - i}</text>`).join('');
  const hex = (x, values) => values.map((v, i) => `<text class="blk-title"
    x="${x + i * CW + (CW - 1) / 2}" y="65" text-anchor="middle" style="font-size:8px">${v}</text>`).join('');

  const byte0 = `${cell(BX[0], 46, '#38bdf8')}${cell(BX[0] + CW, 46, '#38bdf8')}${cell(BX[0] + 2 * CW, 46, '#38bdf8')}${cell(BX[0] + 3 * CW, 46, '#38bdf8')}
    ${cell(BX[0] + 4 * CW, 46, '#a78bfa')}${cell(BX[0] + 5 * CW, 46, '#a78bfa')}${cell(BX[0] + 6 * CW, 46, '#a78bfa')}${cell(BX[0] + 7 * CW, 46, '#a78bfa')}
    ${hex(BX[0], ['1', '0', '0', '1', '0', '0', '1', '0'])}`;
  const byte1 = Array.from({ length: 8 }, (_, i) => cell(BX[1] + i * CW, 46, '#fbbf24')).join('');
  const byte2 = Array.from({ length: 8 }, (_, i) => cell(BX[2] + i * CW, 46, '#34d399')).join('');
  const byte3 = Array.from({ length: 4 }, (_, i) => cell(BX[3] + i * CW, 46, '#f472b6')).join('')
    + ['#22d3ee', '#22d3ee', '#22d3ee', '#22d3ee'].map((c, i) => cell(BX[3] + (4 + i) * CW, 46, c)).join('');

  return `<svg class="model-svg" viewBox="0 0 720 190" xmlns="http://www.w3.org/2000/svg">
    ${BX.map((x, i) => `<text class="arch-label" x="${x + 4 * CW - 4}" y="26" text-anchor="middle">+${i}</text>`).join('')}
    ${BX.map((x) => bits(x, 46, 8)).join('')}

    ${byte0}${byte1}${byte2}${byte3}

    <text class="blk-expr" x="${BX[0] + 2 * CW}" y="92" text-anchor="middle">Fmt = 1001b</text>
    <text class="blk-expr" x="${BX[0] + 6 * CW}" y="92" text-anchor="middle" style="fill:#c4b5fd">Type = 0010b</text>
    <text class="blk-expr" x="${BX[1] + 4 * CW}" y="92" text-anchor="middle" style="fill:#fbbf24">PR_Sent_Counter[7:0]</text>
    <text class="blk-expr" x="${BX[2] + 4 * CW}" y="92" text-anchor="middle" style="fill:#34d399">Stream_ID[7:0]</text>
    <text class="blk-expr" x="${BX[3] + 2 * CW}" y="92" text-anchor="middle" style="fill:#f472b6">Sub-Stream[3:0]</text>
    ${['P', 'M', 'K', 'T'].map((t, i) => `<text class="blk-expr" x="${BX[3] + (4 + i) * CW + (CW - 1) / 2}"
      y="92" text-anchor="middle" style="fill:#22d3ee">${t}</text>`).join('')}

    <text class="arch-note" x="56" y="122">Byte 3：P = PCRC · M = MAC · K = 密钥集（K0/K1）· T = TEE/TVM；M 在不聚合时必须为 1，P 只能在 M=1 时置位。</text>
    <text class="arch-note" x="56" y="140">Sub-Stream：0000 Posted · 0001 Non-Posted · 0010 Completion · 0111 含 OHC-C 但非 IDE 的 TLP。</text>
    <text class="arch-note" x="56" y="158">整前缀 1 DW = 4 B，必须位于所有其它 End-to-End Prefix 之前；Flit Mode 改用 OHC-C，MAC/PCRC 放在 Trailer。</text>
    <text class="arch-note" x="56" y="176">PR_Sent_Counter 只对非 UIO 的 Non-Posted 请求与完成有效，Posted 请求中该字段保留。</text>
  </svg>`;
}

/** IDE 模型：控制平面建立流，数据平面做 AES-GCM；并给出开销估算。 */
export function ideModel(ctx = {}) {
  const link = ctx.link || {};
  const gen = link.gen ?? 4;
  const width = link.width ?? 8;
  const flit = !!link.flitMode;
  const prefix = 4;
  const mac = 12;
  const mss = 256;
  const pctOf = (o) => `${(o / (mss + o) * 100).toFixed(1)}%`;
  const agg4 = prefix + mac / 4;
  return `<div class="model-head">
      <span class="model-badge">IDE · 完整性 / 数据加密</span>
      Gen${gen} ×${width} · ${flit ? 'FM：OHC-C + Trailer' : 'NFM：IDE Prefix + MAC'} · 密钥 256 b
    </div>

    ${sect('架构', '数据平面在 TL 与 DL 之间加解密；控制平面先认证、再编程密钥、最后启用流 · 点击方块查看细节')}
    ${ideArch(link)}

    ${sect('两种流的范围', 'Link IDE 保护整条链路；Selective IDE 只保护选定 TLP，可跨 Switch 逐跳建立')}
    ${stateTable(['类型', '保护对象', '部署边界', '典型用途'], IDE_STREAMS)}
    <p class="hint">同一对端口可以同时使用 Link IDE 与 Selective IDE：Selective 关联的 TLP 用该流的密钥，其余 TLP 用 Link IDE 的密钥。
      Selective IDE 不支持 I/O 请求；配置请求与完成可选保护；本地前缀在 Selective 流中不参与 MAC。</p>

    ${sect('IDE TLP 前缀布局（NFM）', 'IDE Prefix 固定 1 DW = 4 B，必须位于所有其它端到端前缀之前 · 逐字节 / 逐位')}
    ${demo(idePrefixSvg(), 'Byte 0 的 Fmt=1001b 表示端到端 TLP Prefix，Type=0010b 表示 IDE；Byte 3 低位是 P / M / K / T 四个标志。', [
    '<i class="sw blue"></i>Byte 0：Fmt / Type，接收端据此识别这是 IDE Prefix。',
    '<i class="sw amber"></i>Byte 1：PR_Sent_Counter，用于检测 Non-Posted 请求的重放 / 丢失。',
    '<i class="sw green"></i>Byte 2：Stream_ID，决定使用哪条流的密钥。',
    'Byte 3：Sub-Stream 选子流，P 带 PCRC、M 带 MAC、K 选密钥集、T 标记 TEE/TVM。',
  ])}
    ${stateTable(['字节 / 位', '字段', '含义'], IDE_FIELDS)}

    ${sect('动态演示', '明文进、密文出；对端先验 MAC 再解密，失败直接丢弃')}
    ${demo(ideTlpSvg(), 'A 是认证数据（前缀 + Header），P 是明文载荷；加密后只传 C 与 MAC。任何篡改都会让对端的 GHASH 结果不匹配。', [
    '<i class="sw blue"></i>IDE Prefix / OHC-C：告诉接收端「用哪个流、哪个子流、哪套密钥」。',
    '<i class="sw amber"></i>Payload 加密：AES-GCM 的 CTR 部分产生密文，长度不变。',
    '<i class="sw green"></i>MAC：96 b 认证标签，覆盖 A 与 C；对端校验通过后才解密交付。',
    'PCRC 用于发现加解密逻辑自身的故障，不替代 MAC；ECRC 与 IDE 不能同时使用。',
  ])}

    ${sect('IDE 扩展能力（IDE CAP）', '结构 ID 0030h、Version 1h；Header → Capability → Control → Link 块 ×0–8 → Selective 块 ×0–255')}
    ${stateTable(['部分', '关键内容', '说明'], IDE_CAP_STRUCT)}
    ${stateTable(['位', 'IDE Capability Register', '含义'], IDE_CAP_BITS)}
    ${stateTable(['位', 'Stream Control / Status 字段', '含义'], IDE_STREAM_CTRL)}
    <p class="hint">Stream Enable 清 0 会立即把流置回 Insecure；Selected Algorithm、PCRC、RID Base/Limit 与 V 位必须在 Enable 之前配置。
      Default Stream 只适用于 Endpoint Upstream Port，同一 TC 只能有一个默认流。</p>

    ${sect('IDE 密钥管理（IDE_KM）', '基于 SPDM 安全会话：QUERY → KEY_PROG ×6 → K_SET_GO（先 Rx 后 Tx）→ K_GOSTOP_ACK')}
    ${stateTable(['Object ID', '数据对象', '方向', '内容 / 作用'], IDE_KM_OBJS)}
    ${stateTable(['规则', '内容'], IDE_KM_RULES)}
    <p class="hint">KEY_PROG 的 Key 长度由 Selected Algorithm 决定（本版本为 256 b），IFV 为 64 b 且在建立流与换钥时从 0000_0001h 开始。
      两个 Key Set 支持不中断业务的热切换：先编程备用 bank，再翻转 K 位，旧 bank 在收到新键的 TLP 后失效。</p>

    ${sect('建立流程', '认证 → 安全会话 → 编程密钥 → 触发启用；IDE_KM 只是其中一个环节')}
    ${stateTable(['步骤', '做什么', '依靠'], [
    ['1. 身份', '确认两个 Partner 端口所在组件的身份与度量', 'CMA-SPDM / 平台策略 / 隐式信任'],
    ['2. 会话', '建立 SPDM 安全会话，保证密钥传输机密且完整', 'DOE 01h / 02h，或 MCTP'],
    ['3. 密钥', 'QUERY 读能力；对 3 个子流 × Rx/Tx 各发一次 KEY_PROG，收 KP_ACK', 'IDE_KM：256 b Key + 64 b IFV'],
    ['4. 启用', '先给两端发 K_SET_GO(Rx)，再发 K_SET_GO(Tx)，最后置 Stream Enable', '10 ms 内生效；K_GOSTOP_ACK 确认'],
  ])}
    <p class="hint">IDE_KM 的请求 / 响应本身必须放在 Secured-SPDM 里传递；未受保护的 IDE_KM 数据对象必须丢弃且不响应。
      每个流 3 个子流 × Rx/Tx 共 6 把密钥，收发与子流之间不得复用。</p>

    ${sect('状态与错误', '流状态决定能不能发；错误决定丢弃还是继续')}
    ${stateTable(['状态', '条件', '行为'], IDE_STATES)}
    ${stateTable(['错误', '触发', '处理'], IDE_ERRORS)}
    <p class="hint">K 位切换后接收端必须切到新密钥并作废旧 bank；同流其它子流不受影响。换钥不需要把流停下来。</p>

    ${sect('开销估算', '把 MAC 摊到每个 TLP 上，再和载荷比')}
    ${formula([
    'C = AES-GCM_Enc(K, IV, P)；MAC = GHASH_H(A, C) ⊕ E_K(J0)',
    `每 TLP 开销 = ${prefix} B 前缀 + ${mac} B MAC（+4 B PCRC）`,
    `聚合 4 个 TLP：开销 ≈ ${prefix} + ${mac}/4 = ${agg4.toFixed(1)} B/TLP`,
    `有效带宽 ≈ 链路带宽 × MSS / (MSS + 开销)`,
  ], `${mss} B 载荷时：不聚合 ${prefix + mac} B → ${pctOf(prefix + mac)}；聚合 4 个 ${agg4.toFixed(1)} B → ${pctOf(agg4)}。
     估算只含字节开销，不含加解密延迟、聚合等待与重传；Gen${gen} ×${width} 的线速为链路速率扣除编码开销后的值。`)}

    ${sect('与场景的对应')}
    <p class="model-assume">IDE 叠加在现有 TLP 通路之上：模型里的 Gen / Lane / Flit 配置跟随顶栏，但本模拟器不对真实 TLP 做 AES-GCM，
      也不生成 IDE Prefix / MAC，因此时间轴里不会有 IDE 事件。TDISP（第 11 章）用 T 位把 TLP 关联到 TVM，
      并要求受保护链路启用 IDE；IDE 只保证端口到端口的机密性与完整性，片上隔离与访问控制仍由 TSM / DSM 负责。</p>`;
}

/* ---------- TDISP：TEE 设备接口安全协议（PCIe 6.2 第 11 章） ---------- */

const TDISP_ROLES = [
  ['TVM', 'TEE 虚拟机', 'TDI 的拥有者；T 位 TLP 的归属方'],
  ['TSM', '主机侧 TEE 安全管理器', '发起 TDISP、绑定 IDE 流、代表 TVM 决策'],
  ['DSM', '设备侧安全管理器', '锁定 TDI 配置、执行 TDISP 请求'],
  ['TDI', 'TEE 设备接口', 'Function / PF / VF 中可分配给 TVM 的安全子集'],
  ['VMM / PF', '资源管理', '配置 TDI，但不在 TVM 的 TCB 内'],
];

const TDISP_STATES = [
  ['CONFIG_UNLOCKED', '默认状态；VMM 配置 TDI', '拒绝 T=1 的内存请求；STOP 可回到这里', '81h 82h 83h 85h 87h'],
  ['CONFIG_LOCKED', 'LOCK_INTERFACE 后锁定配置', '仍拒绝 T=1 请求；跟踪配置变化', '84h 85h 86h 87h'],
  ['RUN', 'START_INTERFACE 后运行', 'TVM 可访问；T=1 只能走绑定流', '84h 85h 87h 88h 89h 8Ah'],
  ['ERROR', '检测到安全违规', '不暴露机密数据；清理后经 STOP 回 UNLOCKED', '85h 87h'],
];

const TDISP_CONFIG_BITS = [
  ['Device Capabilities +04h bit30', 'TEE-IO Supported', '置 1 表示 Function 实现 TDISP；T 位按 TDISP 解释'],
  ['IDE Capability +04h bit24', 'TEE-Limited Stream Supported', '允许 Selective IDE 只承载 T=1 的 TLP'],
  ['Selective IDE Stream Control bit23', 'TEE-Limited Stream', 'Enable 后变 RO；仅 T=1 的 TLP 可关联该流'],
  ['IDE Prefix / OHC-C Sub-Stream', '000 / 001 / 010 / 0111', 'Posted / Non-Posted / Completion / 非 IDE 的 OHC-C'],
];

const TDISP_CAPS = [
  ['DSM_CAPS', '4 B', 'DSM 能力标志，当前保留（全 0）'],
  ['REQ_MSGS_SUPPORTED', '16 B', '请求码位图：bit index = 请求码 − 80h'],
  ['LOCK_INTERFACE_FLAGS_SUPPORTED', '2 B', '设备支持的 LOCK FLAGS 子集'],
  ['DEV_ADDR_WIDTH', '1 B', '设备地址位数；52 表示支持 Address[51:0]'],
  ['NUM_REQ_THIS', '1 B', '单个 TDI 允许的未完成请求数'],
  ['NUM_REQ_ALL', '1 B', '该 DSM 下所有 TDI 允许的未完成请求数'],
];

const TDISP_LOCK_FLAGS = [
  ['NO_FW_UPDATE', '1 = 锁定 / 运行期间禁止固件更新', '升级前必须先 STOP 回 CONFIG_UNLOCKED'],
  ['System CLS', '0 = 64 B，1 = 128 B', '与 LN Requester 的 Cache Line Size 校验一致'],
  ['LOCK_MSIX', '锁定 MSI-X Table 与 PBA', '未锁定则不得出现在 DEVICE_INTERFACE_REPORT 中'],
  ['BIND_P2P', '允许后续 BIND_P2P_STREAM', '需同时给出有效的 P2P 地址掩码'],
  ['ALL_REQUEST_REDIRECT', '所有 ATS 已翻译请求上送 RC 做访问检查', '防止 TDI 内部地址绕过访问控制'],
];

const TDISP_REPORT = [
  ['INTERFACE_INFO', 'bit0 禁止固件更新；bit1 无 PASID DMA；bit2 有 PASID DMA；bit3 ATS；bit4 PRS'],
  ['MSI_X_MESSAGE_CONTROL', 'MSI-X 未支持或 Table 未锁定时必须为 0'],
  ['LNR_CONTROL / TPH_CONTROL', '对应能力未支持，或 MSI-X 未锁定时必须为 0'],
  ['MMIO_RANGE_COUNT', '报告中的 MMIO 范围个数 N'],
  ['MMIO_RANGE', '每项 16 B：起始 4K 页（加 MMIO_REPORTING_OFFSET）+ 页数 + 属性'],
  ['Range 属性', 'bit0 MSI-X Table；bit1 PBA；bit2 IS_NON_TEE_MEM；bit3 可更新；bits31:16 Range ID'],
];

const TDISP_LOCK_ERRORS = [
  ['INTERFACE_ID 不属于该设备', 'INVALID_INTERFACE（0101h）'],
  ['TDI 不在 CONFIG_UNLOCKED', 'INVALID_INTERFACE_STATE（0004h）'],
  ['默认流不匹配 / 子流密钥缺失 / 密钥非本 SPDM 会话 / 多个默认流 / 非 TC0', 'INVALID_REQUEST（0001h）'],
  ['PF BAR、ROM、VF BAR 重叠，或 Resizable BAR 尺寸不支持', 'INVALID_DEVICE_CONFIGURATION（0104h）'],
  ['Phantom Functions、页大小、CLS、TPH ST 模式不支持', 'INVALID_DEVICE_CONFIGURATION（0104h）'],
];

const TDISP_START_STOP = [
  ['START 86h', 'nonce 必须等于 LOCK 生成值，TDI 必须在 CONFIG_LOCKED；成功后销毁 nonce', 'INVALID_NONCE / INVALID_INTERFACE_STATE'],
  ['STOP 87h', '中止在途操作、DMA 完成或中止、ATS 失效、PRI 收尾、擦除机密、回收密钥', '完成后回 CONFIG_UNLOCKED'],
];

const TDISP_MSGS = [
  ['81h', 'GET_TDISP_VERSION', 'N/A', '读版本；V1.0 编码为 10h'],
  ['82h', 'GET_TDISP_CAPABILITIES', 'N/A', '读协议能力'],
  ['83h', 'LOCK_INTERFACE_REQUEST', 'CONFIG_UNLOCKED', '锁定配置；携带 IDE Stream ID 与 nonce'],
  ['84h', 'GET_DEVICE_INTERFACE_REPORT', 'CONFIG_LOCKED / RUN', '返回 TDI 报告供 TVM 评估'],
  ['85h', 'GET_DEVICE_INTERFACE_STATE', '所有状态', '查询 TDI 当前状态'],
  ['86h', 'START_INTERFACE_REQUEST', 'CONFIG_LOCKED', '校验 nonce，把 TDI 置入 RUN'],
  ['87h', 'STOP_INTERFACE_REQUEST', '所有状态', '清理机密数据并回到 CONFIG_UNLOCKED'],
  ['88h / 89h', 'BIND / UNBIND_P2P_STREAM', 'RUN', '绑定 / 解绑 P2P 用的 Selective IDE 流'],
  ['8Ah', 'SET_MMIO_ATTRIBUTE_REQUEST', 'RUN', '更新指定 MMIO 范围的属性'],
];

const TDISP_TLP_RULES = [
  ['T 位', 'T=1 表示 TLP 属于 TVM', '只有绑定到该 TDI 的 IDE 流可承载；Completion 的 T 位必须与请求一致'],
  ['Requester 请求', 'CONFIG_LOCKED / RUN 才可发 T=1', '未绑定 P2P 的 TLP 必须走锁定时的 default stream'],
  ['内存读', '仅 RUN，且 T=1', '完成后仍须 RUN 才处理，否则拒绝'],
  ['内存写', '仅 RUN，且 T=1', 'MSI / MSI-X 中断按下一行处理'],
  ['MSI / MSI-X', 'MSI 与未锁定的 MSI-X 用 T=0；已锁定并报告的 MSI-X 用 T=1', 'CONFIG_LOCKED 只允许 T=0 的中断'],
  ['Completer 规则', 'IS_NON_TEE_MEM=0 的内存必须同时满足 T=1、RUN、绑定流', '任一条件不满足即拒绝'],
  ['I/O 请求', 'TDI 不得依赖 I/O 资源', '避免绕过 MMIO / DMA 访问控制'],
  ['ATS / PRI', '失效请求、失效完成、Page Request、PRG 按第 11.4.10 节', 'T 位与流绑定规则同样适用'],
  ['P2P', '仅 RUN；需 ATS + 绑定的 Selective IDE 流', 'TSM 与 VMM 协调 ACS 重定向'],
];

const TDISP_ERRORS = [
  ['配置变更', '锁定后 TDI 配置被修改', '转 ERROR'],
  ['FLR', '对 TDI 做功能级复位', '转 ERROR；PF 复位影响下属 VF TDI'],
  ['Requester ID 改变', '身份不再可信', '转 ERROR'],
  ['IDE 流 Insecure', '绑定到 TDI 的流失去安全状态', '转 ERROR'],
  ['不可恢复的数据完整性错误', '中毒 TLP 等无法恢复的错误', '转 ERROR'],
];

function tdispBox(x, y, w, h, title, sub, color, key) {
  const ty = y + Math.round(h * 0.38);
  const sy = y + Math.round(h * 0.62);
  return `<g class="arch-link" data-arch="${key}" role="button" tabindex="0" aria-label="${title}">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#0c1729" stroke="${color}"/>
    <text class="blk-title" x="${x + w / 2}" y="${ty}" text-anchor="middle">${title}</text>
    <text class="blk-expr" x="${x + w / 2}" y="${sy}" text-anchor="middle" style="fill:${color}">${sub}</text>
  </g>`;
}

function tdispArch() {
  return `<svg class="model-svg" viewBox="0 0 720 470" xmlns="http://www.w3.org/2000/svg">
    <!-- Host -->
    <rect x="8" y="28" width="704" height="146" rx="14" fill="rgba(30,58,95,0.12)"
      stroke="#2b4162" stroke-dasharray="7 5"/>
    <text class="arch-note" x="18" y="42">TEE I/O Capable Host</text>

    ${tdispBox(20, 44, 96, 42, 'VMM', '资源分配', '#94a3b8', 'tdisp-vmm')}
    ${tdispBox(128, 44, 96, 42, 'Legacy VM', '信任 VMM', '#94a3b8', 'tdisp-legacy')}
    ${tdispBox(236, 44, 96, 42, 'TVM', 'TEE 虚拟机', '#38bdf8', 'tdisp-tvm')}
    ${tdispBox(344, 44, 96, 42, 'TVM', 'TEE 虚拟机', '#38bdf8', 'tdisp-tvm2')}
    ${tdispBox(456, 44, 236, 42, 'TEE Security Manager（TSM）', '认证 · TDISP · IDE 密钥', '#a78bfa', 'tdisp-tsm')}

    ${tdispBox(20, 104, 140, 42, 'TEE memory', '机密 / 可选完整性', '#34d399', 'tdisp-mem')}
    ${tdispBox(172, 104, 140, 42, 'Non-TEE memory', '无机密性保证', '#94a3b8', 'tdisp-mem2')}
    ${tdispBox(324, 104, 140, 42, 'TA / IOMMU', 'HPA → TDI', '#a78bfa', 'tdisp-ta')}
    <text class="arch-label" x="480" y="130" style="fill:#7b93b1">HPA · RID / PASID</text>

    <line x1="284" y1="88" x2="348" y2="102" stroke="#38bdf8" stroke-width="1.3"/>
    <polygon points="352,104 344,100 347,93" fill="#38bdf8"/>
    <line x1="392" y1="88" x2="392" y2="100" stroke="#38bdf8" stroke-width="1.3"/>
    <polygon points="392,104 388,96 396,96" fill="#38bdf8"/>
    <path d="M90,146 L90,158 L394,158 L394,150" fill="none" stroke="#34d399" stroke-width="1.3"/>
    <polygon points="394,146 390,154 398,154" fill="#34d399"/>
    <text class="arch-label" x="240" y="170" text-anchor="middle" style="fill:#34d399">MMIO / DMA</text>

    <!-- Fabric -->
    <rect x="8" y="186" width="704" height="52" rx="12" fill="rgba(56,189,248,0.05)"
      stroke="#2b4162" stroke-dasharray="5 4"/>
    <text class="arch-note" x="360" y="204" text-anchor="middle">PCIe Fabric（Switches need not be trusted）</text>
    <text class="arch-note" x="360" y="221" text-anchor="middle">数据面必须 IDE；管理面走 SPDM / TDISP 安全会话</text>

    <g class="arch-link" data-arch="tdisp-msg" role="button" tabindex="0" aria-label="SPDM / TDISP 安全会话">
      <line x1="574" y1="88" x2="574" y2="264" stroke="#a78bfa" stroke-width="1.4" stroke-dasharray="6 4"/>
      <polygon points="574,268 570,260 578,260" fill="#a78bfa"/>
    </g>
    <text class="arch-label" x="582" y="170" style="fill:#c4b5fd">SPDM / TDISP（DOE）</text>

    <g class="arch-link" data-arch="tdisp-data" role="button" tabindex="0" aria-label="MMIO / DMA 数据通路">
      <path d="M450,148 L450,178 L650,178 L650,262" fill="none" stroke="#22d3ee" stroke-width="1.4"/>
      <polygon points="650,266 646,258 654,258" fill="#22d3ee"/>
    </g>
    <text class="arch-label" x="642" y="212" text-anchor="end" style="fill:#22d3ee">MMIO / DMA + IDE</text>

    <!-- Device -->
    <rect x="8" y="250" width="704" height="180" rx="14" fill="rgba(30,58,95,0.12)"
      stroke="#2b4162" stroke-dasharray="7 5"/>
    <text class="arch-note" x="18" y="264">TEE I/O Capable Device</text>

    ${tdispBox(20, 274, 96, 42, 'PF', '管理接口', '#f87171', 'tdisp-pf')}
    ${tdispBox(128, 274, 96, 42, 'TDI', 'TDISP 接口', '#34d399', 'tdisp-tdi')}
    ${tdispBox(236, 274, 96, 42, 'TDI', 'TDISP 接口', '#34d399', 'tdisp-tdi2')}
    ${tdispBox(344, 274, 96, 42, 'TDI', 'TDISP 接口', '#34d399', 'tdisp-tdi3')}
    ${tdispBox(456, 274, 140, 42, 'DSM', '设备侧信任代理', '#a78bfa', 'tdisp-dsm')}
    ${tdispBox(608, 274, 84, 42, 'ATC', 'ATS 缓存', '#a78bfa', 'tdisp-atc')}

    <line x1="116" y1="295" x2="124" y2="295" stroke="#f87171" stroke-width="1.3" stroke-dasharray="4 3"/>
    <line x1="452" y1="295" x2="444" y2="295" stroke="#a78bfa" stroke-width="1.4"/>
    <polygon points="440,295 448,291 448,299" fill="#a78bfa"/>

    <g class="arch-link" data-arch="tdisp-statechip" role="button" tabindex="0" aria-label="TDISP 状态">
      <rect x="128" y="326" width="96" height="30" rx="6" fill="#0c1729" stroke="#3a5578"/>
      <text class="blk-expr" x="176" y="345" text-anchor="middle">TDISP state</text>
      <rect x="236" y="326" width="96" height="30" rx="6" fill="#0c1729" stroke="#3a5578"/>
      <text class="blk-expr" x="284" y="345" text-anchor="middle">TDISP state</text>
      <rect x="344" y="326" width="96" height="30" rx="6" fill="#0c1729" stroke="#3a5578"/>
      <text class="blk-expr" x="392" y="345" text-anchor="middle">TDISP state</text>
    </g>

    <g class="arch-link" data-arch="tdisp-cert" role="button" tabindex="0" aria-label="设备证书与私钥">
      <rect x="456" y="326" width="236" height="52" rx="8" fill="#0c1729" stroke="#a78bfa" stroke-dasharray="4 3"/>
      <text class="blk-title" x="574" y="344" text-anchor="middle">ModelCert · per-part DevPrivKey</text>
      <text class="blk-expr" x="574" y="360" text-anchor="middle" style="fill:#c4b5fd">DevCert（设备身份与度量）</text>
    </g>

    <text class="arch-note" x="20" y="404">PF 由 VMM 中的 PF 驱动管理，不在 TVM 的 TCB 内；TDI 可以是整个设备、非 IOV Function、PF（含下属 VF）或单个 VF。</text>
    <text class="arch-note" x="20" y="422">TDI 在任何时刻只有一个 TDISP 状态；DSM 独立于 PF，负责锁定、报告、启动、停止与配置跟踪。</text>

    <!-- 图例 -->
    <rect x="20" y="448" width="10" height="8" rx="2" fill="#38bdf8"/>
    <text class="arch-label" x="36" y="456" style="fill:#7dd3fc">在 TVM 的 TCB（接受设备的 TVM）</text>
    <rect x="240" y="448" width="10" height="8" rx="2" fill="#34d399"/>
    <text class="arch-label" x="256" y="456" style="fill:#6ee7b7">在所有 TVM 的 TCB</text>
    <rect x="430" y="448" width="10" height="8" rx="2" fill="#f87171"/>
    <text class="arch-label" x="446" y="456" style="fill:#fca5a5">不在 TVM 的 TCB</text>
  </svg>`;
}

function tdispStateSvg() {
  const box = (x, y, title, sub, codes, color) => `<rect x="${x}" y="${y}" width="150" height="74" rx="9"
      fill="#0c1729" stroke="${color}"/>
    <text class="blk-title" x="${x + 75}" y="${y + 20}" text-anchor="middle">${title}</text>
    <text class="blk-expr" x="${x + 75}" y="${y + 38}" text-anchor="middle" style="fill:${color}">${sub}</text>
    <text class="blk-val" x="${x + 75}" y="${y + 58}" text-anchor="middle">可收：${codes}</text>`;
  return `<svg class="model-svg" viewBox="0 0 720 330" xmlns="http://www.w3.org/2000/svg">
    ${box(30, 88, 'CONFIG_UNLOCKED', '默认 / VMM 配置', '81h 82h 83h 85h 87h', '#94a3b8')}
    ${box(270, 88, 'CONFIG_LOCKED', '配置已锁定', '84h 85h 86h 87h', '#fbbf24')}
    ${box(510, 88, 'RUN', 'TVM 可访问', '84h 85h 87h 88h 89h 8Ah', '#34d399')}
    ${box(270, 210, 'ERROR', '安全违规', '85h 87h', '#f87171')}

    ${archArrow(180, 266, 125, 'LOCK 83h', 'tdisp-lock')}
    ${archArrow(420, 506, 125, 'START 86h', 'tdisp-start')}

    <line x1="345" y1="162" x2="345" y2="206" stroke="#f87171" stroke-width="1.4"/>
    <polygon points="345,210 341,202 349,202" fill="#f87171"/>
    <text class="arch-label" x="352" y="188" style="fill:#f87171">错误</text>

    <line x1="585" y1="162" x2="432" y2="208" stroke="#f87171" stroke-width="1.3" stroke-dasharray="4 3"/>
    <polygon points="428,210 437,208 434,201" fill="#f87171"/>
    <text class="arch-label" x="522" y="194" style="fill:#f87171">错误</text>

    <path d="M270,247 C170,247 105,215 105,166" fill="none" stroke="#38bdf8" stroke-width="1.4"/>
    <polygon points="105,162 101,170 109,170" fill="#38bdf8"/>
    <text class="arch-label" x="122" y="262" style="fill:#7dd3fc">STOP 87h</text>

    <text class="arch-note" x="30" y="316">CONFIG_LOCKED / RUN = locked；CONFIG_UNLOCKED / ERROR = unlocked。STOP 可从任意状态回到 CONFIG_UNLOCKED。</text>
  </svg>`;
}

function tdispFlowSvg() {
  const TSM = 170;
  const DSM = 560;
  const rows = [
    [64, '① GET_TDISP_VERSION (81h)'],
    [98, '② GET_TDISP_CAPABILITIES (82h)'],
    [132, '③ LOCK_INTERFACE_REQUEST (83h) · IDE Stream ID + nonce'],
    [166, '④ GET_DEVICE_INTERFACE_REPORT (84h)'],
    [200, '⑤ START_INTERFACE_REQUEST (86h) · 校验 nonce'],
  ];
  const step = (y, i, label) => {
    const t0 = 0.04 + i * 0.12;
    const a = t0.toFixed(3);
    const b = (t0 + 0.012).toFixed(3);
    const c = (t0 + 0.07).toFixed(3);
    const d = (t0 + 0.082).toFixed(3);
    return `<line x1="${TSM}" y1="${y}" x2="${DSM}" y2="${y}" stroke="#38bdf8" stroke-width="1.3"/>
      <polygon points="${DSM},${y} ${DSM - 7},${y - 3.5} ${DSM - 7},${y + 3.5}" fill="#38bdf8"/>
      <text class="arch-label" x="${(TSM + DSM) / 2}" y="${y - 7}" text-anchor="middle">${label}</text>
      <g opacity="0">
        <animate attributeName="opacity" values="0;0;1;1;0;0"
          keyTimes="0;${a};${b};${c};${d};1" dur="9s" repeatCount="indefinite"/>
        <circle r="3" fill="#38bdf8"><animateMotion dur="9s" repeatCount="indefinite" calcMode="linear"
          keyTimes="0;${a};${c};1" keyPoints="0;0;1;1" path="M${TSM},${y} L${DSM},${y}"/></circle>
      </g>`;
  };
  const tail = (y) => `<line x1="${TSM}" y1="${y}" x2="${DSM}" y2="${y}" stroke="#34d399" stroke-width="1.3"/>
    <polygon points="${DSM},${y} ${DSM - 7},${y - 3.5} ${DSM - 7},${y + 3.5}" fill="#34d399"/>
    <text class="arch-label" x="${(TSM + DSM) / 2}" y="${y - 7}" text-anchor="middle" style="fill:#34d399">⑦ STOP_INTERFACE_REQUEST (87h) → CONFIG_UNLOCKED</text>`;
  return `<svg class="model-svg" viewBox="0 0 720 330" xmlns="http://www.w3.org/2000/svg">
    <line x1="${TSM}" y1="44" x2="${TSM}" y2="288" stroke="#22314c" stroke-dasharray="4 4"/>
    <line x1="${DSM}" y1="44" x2="${DSM}" y2="288" stroke="#22314c" stroke-dasharray="4 4"/>
    <rect x="${TSM - 40}" y="20" width="80" height="22" rx="6" fill="#0c1729" stroke="#a78bfa"/>
    <text class="blk-title" x="${TSM}" y="35" text-anchor="middle">TSM</text>
    <rect x="${DSM - 40}" y="20" width="80" height="22" rx="6" fill="#0c1729" stroke="#a78bfa"/>
    <text class="blk-title" x="${DSM}" y="35" text-anchor="middle">DSM</text>

    ${rows.map(([y, label], i) => step(y, i, label)).join('')}
    <rect x="410" y="222" width="270" height="24" rx="6" fill="rgba(52,211,153,0.08)" stroke="#34d399"/>
    <text class="arch-label" x="545" y="238" text-anchor="middle" style="fill:#34d399">⑥ RUN：T=1 的 TLP 只走绑定到 TDI 的 IDE 流</text>
    ${tail(268)}

    <text class="arch-note" x="12" y="310">每条请求都有对应响应；状态不合法或请求码不支持时返回 TDISP_ERROR（7Fh）。</text>
  </svg>`;
}

/** TDISP 模型：TSM / DSM 管理 TDI 状态机，并用 IDE + T 位承载 TVM 数据。 */
export function tdispModel(ctx = {}) {
  const link = ctx.link || {};
  const gen = link.gen ?? 4;
  const width = link.width ?? 8;
  const flit = link.flitMode ? 'OHC-C' : 'IDE Prefix';
  return `<div class="model-head">
      <span class="model-badge">TDISP · TEE 设备接口</span>
      Gen${gen} ×${width} · ${flit} 的 T 位 · TDISP V1.0（10h）
    </div>

    ${sect('架构', '按 Figure 11-2 组织：VMM / Legacy VM 不在 TVM 的 TCB，TVM 只信任 TSM；设备侧 PF 不受信任，DSM 管理 TDI · 点击方块查看细节')}
    ${tdispArch()}
    <p class="hint">信任边界（图例）：蓝色 = 只在接受设备的 TVM 的 TCB；绿色 = 在所有 TVM 的 TCB；灰色 / 红色 = 不在 TVM 的 TCB。
      TVM 的 MMIO 请求经 TA 用 HPA 路由到 TDI；TDI 发出的请求带 RID（可选 PASID），T 位把它们关联到 TVM。</p>

    ${sect('角色分工', '谁在 TVM 的信任边界内，谁只负责资源管理')}
    ${stateTable(['角色', '定位', '职责'], TDISP_ROLES)}
    <p class="hint">TSM 的职责：分配内存 / CPU / TDI、维护 IOMMU 等访问控制、用 TDISP 管理 TDI 状态、建立并刷新 IDE 密钥。
      DSM 的职责：设备身份认证与度量、编程 IDE 密钥、锁定 / 报告 / 附加 / 分离 TDI、隔离 TVM 数据。</p>

    ${sect('能力与配置（.cap）', 'TDISP 能力由配置位与 TDISP_CAPABILITIES 共同描述')}
    ${stateTable(['位置', '字段', '含义'], TDISP_CONFIG_BITS)}
    ${stateTable(['字段', '大小', '含义'], TDISP_CAPS)}
    <p class="hint">REQ_MSGS_SUPPORTED 的 bit index 等于请求码减 80h；未置位的请求码必须返回 UNSUPPORTED_REQUEST。
      DEV_ADDR_WIDTH 让 TSM 知道设备能寻址多少位，NUM_REQ_THIS / NUM_REQ_ALL 限制未完成请求数量。</p>

    ${sect('TDI 状态机', 'TSM 驱动 TDI 走完 配置 → 锁定 → 运行 → 停止 的生命周期；每个状态只接受固定消息')}
    ${tdispStateSvg()}
    ${stateTable(['状态', '进入条件', '行为', '允许的消息'], TDISP_STATES)}
    <p class="hint">只有 CONFIG_LOCKED 与 RUN 是 locked；ERROR 与 CONFIG_UNLOCKED 是 unlocked。进入 ERROR 时不得再暴露 TVM 机密数据，清理可延迟到 STOP。</p>

    ${sect('消息与顺序', '先认证、再锁定、再报告、最后启动；请求 / 响应都必须在安全会话内')}
    ${demo(tdispFlowSvg(), 'LOCK 携带 IDE Stream ID 与设备生成的 nonce；START 校验同一 nonce，确保两次转换发生在同一个 SPDM 安全会话中。', [
    '<i class="sw blue"></i>81h / 82h：读版本与能力，不依赖 TDI 状态。',
    '<i class="sw amber"></i>83h：VMM 配置完成后锁定；携带 IDE Stream ID 与 nonce。',
    '<i class="sw green"></i>84h / 86h：TVM 先看报告再批准；START 校验 nonce 后进入 RUN。',
    '87h：任意状态都可 STOP，清理机密数据并回到 CONFIG_UNLOCKED。',
  ])}
    ${stateTable(['码', '请求', '合法状态', '作用'], TDISP_MSGS)}
    <p class="hint">不支持的请求码必须返回 ERROR_CODE=UNSUPPORTED_REQUEST 的 TDISP_ERROR（7Fh）；未定义响应码按 TDISP_ERROR 处理。
      LOCK 响应携带 32 B START_INTERFACE_NONCE，TDI 离开 CONFIG_LOCKED 或进入 ERROR 时必须销毁。</p>

    ${sect('锁定参数与失败条件', 'LOCK 不是简单置位：它绑定 IDE 流、MMIO 偏移与一组锁定策略')}
    ${stateTable(['FLAGS 位', '含义', '影响'], TDISP_LOCK_FLAGS)}
    ${stateTable(['失败条件', '错误码'], TDISP_LOCK_ERRORS)}
    <p class="hint">MMIO_REPORTING_OFFSET 会加到之后所有报告地址上，避免把主机物理地址泄露给 TVM；BIND_P2P_ADDRESS_MASK 在匹配 Selective IDE 地址关联前先清掉元数据位。</p>

    ${sect('启动与停止', 'START 消费 nonce；STOP 负责把设备里的 TVM 痕迹清干净')}
    ${stateTable(['消息', '动作', '错误 / 结果'], TDISP_START_STOP)}

    ${sect('TDI 报告', 'DEVICE_INTERFACE_REPORT 可能分段返回，TVM 据此建立 MMIO 映射')}
    ${stateTable(['字段', '内容'], TDISP_REPORT)}
    <p class="hint">报告按 OFFSET / LENGTH 分段：响应里 PORTION_LENGTH 是本次长度，REMAINDER_LENGTH 是剩余长度，为 0 表示结束。
      MMIO 范围按 BAR 升序报告，Range ID 低 3 位表示 BAR 等价指示（BEI）。</p>

    ${sect('TLP 规则', 'T 位把 TLP 绑定到 TVM；IDE 流把这条通路加密')}
    ${stateTable(['对象', '规则', '说明'], TDISP_TLP_RULES)}
    <p class="hint">配置请求不要求加密，但锁定后的配置写入会被 DSM 跟踪；一旦影响到 TDI 安全属性，就按 ERROR 处理。RCiEP 等不需要 IDE 的场景可用等价的 T 位指示。</p>

    ${sect('错误与降级', '锁定后任何可疑变化都转 ERROR，而不是继续运行')}
    ${stateTable(['触发', '条件', '结果'], TDISP_ERRORS)}

    ${sect('消息格式与安全传输', '所有 TDISP 消息共享固定头部，并作为 Secured-SPDM 的 Application Data 传输')}
    ${formula([
    '帧：TDISPVersion(1 B) + MessageType(1 B) + Reserved(2 B) + INTERFACE_ID(12 B) + payload',
    '版本：Major[7:4] / Minor[3:0]；V1.0 = 10h',
    '安全传输：Secured-SPDM，AEAD 使用 AES-256-GCM',
    'nonce 绑定：LOCK 生成 → START 校验；非法状态 → TDISP_ERROR(7Fh)',
  ], `当前链路 Gen${gen} ×${width}：TDISP 消息本身是管理面流量，经 DOE 逐 DW 搬运；
     TVM 的真实数据走 IDE 流，T 位放在 ${flit} 中，链路开销按 IDE 模型计算。`)}

    ${sect('与场景的对应')}
    <p class="model-assume">本模拟器没有实现 TDISP 寄存器、TDISP 消息或 TDI 状态，也不重放 GET_* / LOCK / START 事件；
      模型只解释协议与状态机。TDISP 依赖的 IDE、DOE 分别见同组的「IDE 完整性 / 数据加密」与「DOE 数据对象交换」。
      设备内部的隔离、密钥保护与 PF 防篡改属于设备安全架构，规范只给出要求，不规定实现。</p>`;
}

/* ---------- 架构方块说明：点击方块弹出公式与物理含义 ---------- */

const ARCH_INFO = {
  eq: {
    ffe: {
      title: 'TX FFE · 3 抽头前馈均衡',
      formula: [
        'y[n] = c₋₁·x[n+1] + c₀·x[n] + c₁·x[n−1]',
        'c₋₁ + c₀ + c₁ = 1',
      ],
      meaning: '发送端按相邻符号加权叠加，对信号做预失真（预加重 / 去加重），提前补偿信道高频衰减，使到达接收端的脉冲更接近理想。',
      value: (s) => `当前 ${s.eq.name}：pre ${n2(s.eq.pre)} / cursor ${n2(s.eq.cursor)} / post ${n2(s.eq.post)}`,
    },
    channel: {
      title: '信道 · PCB / 线缆',
      formula: ['r[n] = α₋₁·x[n+1] + x[n] + α₁·x[n−1]'],
      meaning: '信道呈低通特性，脉冲能量泄漏到相邻 UI，形成 pre-cursor / post-cursor ISI；损耗随代际升高而加剧。',
      value: (s) => `损耗 ${s.channel.lossDb} dB · α₋₁ = ${n2(s.channel.preIsi)} / α₁ = ${n2(s.channel.postIsi)}`,
    },
    ctle: {
      title: 'RX CTLE · 连续时间线性均衡',
      formula: ['H_CTLE(s) = G / (1 + s/ω_p)', 'η_CTLE = G / 20'],
      meaning: '抬升高频、压低低频，补偿信道低通；线性放大在改善 ISI 的同时也会放大噪声与串扰。',
      value: (s) => `${s.rxEq.ctleDb} dB · η_CTLE = ${n2(s.rxEq.ctleDb / 20)}`,
    },
    dfe: {
      title: 'RX DFE · 判决反馈均衡',
      formula: ['z[n] = r[n] − Σₖ dₖ·ŝ[n−k]', 'η_DFE = 0.05 · N_DFE'],
      meaning: '用已经判决的符号估计并减掉 post-cursor ISI，不放大噪声；但无法消除 pre-cursor ISI。',
      value: (s) => `${s.rxEq.dfeTaps} tap · η_DFE = ${n2(s.rxEq.dfeTaps * 0.05)}`,
    },
    sampler: {
      title: '采样判决与眼图',
      formula: [
        'E = 1 − (preISI·(1−c₋₁/0.35) + postISI·(1−c₁/0.45))·(1−η) − 0.3(1−c₀)',
        'COM = 20·lg(E) + 10 + G_FEC − P_CDR',
      ],
      meaning: '在眼心对均衡后的信号采样并判决为 0/1；眼开度与 COM 决定误码率，COM < 3 dB 时链路视为不可用。',
      value: (s) => `眼开度 ${pct(s.metrics.eyeOpening)} · COM ${n1(s.metrics.comDb)} dB · BER ${s.metrics.ber.toExponential(1)}`,
    },
    in: {
      title: '输入符号 x[n]',
      kind: '信号',
      io: '串行数据 → x[n]',
      formula: ['x[n] ∈ {+1, −1}（NRZ）', 'Gen6：PAM4 4 电平 {−3, −1, +1, +3}'],
      meaning: '发送端待发送的符号序列，每个符号占 1 UI；FFE、信道与各级均衡都以它为基准。',
      value: (s) => `UI ${n1(s.metrics.uiPs)} ps · ${s.metrics.pam4 ? 'PAM4 4 电平' : 'NRZ 2 电平'}`,
    },
    'sig-y': {
      title: 'y[n] · FFE 输出',
      kind: '信号',
      io: 'x[n] → y[n]',
      formula: ['y[n] = c₋₁x[n+1] + c₀x[n] + c₁x[n−1]'],
      meaning: '预失真后的发送波形：相邻符号被加重 / 去加重，高频分量提前抬升，用以抵消信道低通。',
      value: (s) => `预设 ${s.eq.name}：pre ${n2(s.eq.pre)} / cursor ${n2(s.eq.cursor)} / post ${n2(s.eq.post)}`,
    },
    'sig-r': {
      title: 'r[n] · 信道输出',
      kind: '信号',
      io: 'y[n] → r[n]',
      formula: ['r[n] = α₋₁x[n+1] + x[n] + α₁x[n−1]'],
      meaning: '经 PCB / 线缆低通后的接收波形；能量泄漏到相邻 UI，形成 pre-cursor 与 post-cursor ISI。',
      value: (s) => `损耗 ${s.channel.lossDb} dB · α₋₁ ${n2(s.channel.preIsi)} / α₁ ${n2(s.channel.postIsi)}`,
    },
    'sig-z1': {
      title: 'z₁[n] · CTLE 输出',
      kind: '信号',
      io: 'r[n] → z₁[n]',
      formula: ['z₁[n] = (1 + η_CTLE)·r[n]'],
      meaning: 'CTLE 抬升高频后的波形：ISI 被部分压平，但噪声与串扰同步放大。',
      value: (s) => `CTLE ${s.rxEq.ctleDb} dB · η_CTLE ${n2(s.rxEq.ctleDb / 20)}`,
    },
    'sig-z': {
      title: 'z[n] · DFE 输出',
      kind: '信号',
      io: 'z₁[n] → z[n]',
      formula: ['z[n] = z₁[n] − Σₖ dₖ·ŝ[n−k]'],
      meaning: '用已判决符号减掉 post-cursor ISI 后的波形，送入采样器时眼开度最大。',
      value: (s) => `${s.rxEq.dfeTaps} tap · η_DFE ${n2(s.rxEq.dfeTaps * 0.05)}`,
    },
    out: {
      title: '判决输出 · bits',
      kind: '信号',
      io: 'z[n] → 数字比特流',
      formula: ['NRZ：ŝ[n] = sign(z[n])', 'PAM4：3 个比较器 → 2 bit'],
      meaning: '采样器把均衡后的模拟波形判决为数字符号，输出给链路层；判决错误即误码。',
      value: (s) => `BER ${s.metrics.ber.toExponential(1)} · COM ${n1(s.metrics.comDb)} dB`,
    },
  },
  cdr: {
    pd: {
      title: '相位检测器 PD',
      formula: ['φ_e = K_d·(φ_in − φ_out)'],
      meaning: '比较数据边沿与恢复时钟的相位差，输出相位误差 φ_e；φ_e → 0 表示采样点落在眼心。',
      value: (s) => `φ_e = ${s.cdr.phaseErrorDeg}°`,
    },
    lf: {
      title: '环路滤波 · 比例 + 积分',
      formula: ['φ_c = K_p·φ_e + K_i·∫φ_e dt'],
      meaning: '比例项决定瞬时响应，积分项消除稳态相差；带宽越大锁定越快，但对 jitter 的抑制越弱。',
      value: (s) => `频偏 ${s.cdr.freqErrorPpm} ppm（牵引范围 ±300 ppm）`,
    },
    vco: {
      title: 'VCO / 采样时钟',
      formula: ['f = f₀ + K_v·φ_c', 't_s = (φ_e / 360°)·UI'],
      meaning: '压控振荡器按控制相位微调频率，产生采样时钟；锁定后采样点对准眼心，未锁定时眼图闭合。',
      value: (s) => `${cdrText(s.cdr.state)} · ${s.rateGts} GT/s`,
    },
    in: {
      title: 'r(t) · 数据边沿',
      kind: '信号',
      io: '接收数据 → PD',
      formula: ['r(t) 的过零点携带相位信息'],
      meaning: '数据跳变沿作为相位参考；连续相同比特时没有边沿，靠环路惯性维持相位。',
      value: (s) => `UI ${n1(s.metrics.uiPs)} ps · ${cdrText(s.cdr.state)}`,
    },
    'sig-pe': {
      title: 'φ_e · 相位误差',
      kind: '信号',
      io: 'PD → 环路滤波',
      formula: ['φ_e = K_d·(φ_in − φ_out)'],
      meaning: '采样点偏离眼心的相位量；φ_e → 0 表示采样点对准眼心。',
      value: (s) => `φ_e = ${s.cdr.phaseErrorDeg}°（当前仿真）`,
    },
    'sig-pc': {
      title: 'φ_c · 控制量',
      kind: '信号',
      io: '环路滤波 → VCO',
      formula: ['φ_c = K_p·φ_e + K_i·∫φ_e dt'],
      meaning: '包含瞬时修正与累积修正，驱动 VCO 调整频率 / 相位。',
      value: (s) => `频偏 ${s.cdr.freqErrorPpm} ppm`,
    },
    out: {
      title: 'f_clk · 恢复采样时钟',
      kind: '信号',
      io: 'VCO → 采样 / 判决',
      formula: ['f_clk = f₀ + K_v·φ_c'],
      meaning: '恢复出的采样时钟，相位锁定在数据眼心，用于逐比特判决。',
      value: (s) => `${cdrText(s.cdr.state)} · ${s.rateGts} GT/s`,
    },
    fb: {
      title: 'φ_out · 反馈相位',
      kind: '信号',
      io: 'VCO → PD',
      formula: ['φ_out 直接反馈到 PD 的 φ_in 端'],
      meaning: 'CDR 无分频，VCO 相位直接回送 PD 形成闭环；反馈延迟与环路带宽决定 jitter 跟踪能力。',
      value: (s) => `当前 ${cdrText(s.cdr.state)}`,
    },
  },
  pll: {
    pd: {
      title: '鉴相器 PD',
      formula: ['φ_e = φ_ref − φ_fb'],
      meaning: '比较参考时钟与反馈时钟的相位，误差经环路滤波后控制 VCO；φ_e → 0 即锁定。',
      value: (s) => `${s.pll.locked ? '已锁定' : '未锁定'} · REF ${s.refClk.freqMHz} MHz`,
    },
    lf: {
      title: '环路滤波',
      formula: ['φ_c = K_p·φ_e + K_i·∫φ_e dt'],
      meaning: '决定环路带宽、锁定时间与稳定性：带宽大锁定快但抖动抑制差，带宽小则相反。',
      value: () => 'K_p / K_i 决定环路带宽与阻尼',
    },
    vco: {
      title: 'VCO · 压控振荡器',
      formula: ['f_vco = f₀ + K_v·φ_c'],
      meaning: '把控制电压转换为频率偏移，输出高速比特时钟；jitter 直接叠加在输出边沿上。',
      value: (s) => `${n1(s.pll.freqGHz)} GHz · jitter ${s.pll.jitterPs} ps`,
    },
    div: {
      title: '分频器 ÷N',
      formula: ['f_fb = f_vco / N', 'N = f_rate / f_REF'],
      meaning: '把 VCO 输出降频后反馈到鉴相器，使输出频率为参考的 N 倍；N 决定目标速率。',
      value: (s) => `N = ${Math.round(s.rateGts / (s.refClk.freqMHz / 1000))}`,
    },
    in: {
      title: 'REF CLK · 参考时钟',
      kind: '信号',
      io: '板级时钟 → PD',
      formula: ['f_ref = 100 MHz'],
      meaning: '参考时钟的长期精度决定输出频率；其 ppm 偏差与 SSC 会直接传递到 VCO。',
      value: (s) => `100 MHz · ${s.refClk.ppm} ppm${s.refClk.ssc ? ' · SSC' : ''}`,
    },
    'sig-pe': {
      title: 'φ_e · 相位误差',
      kind: '信号',
      io: 'PD → 环路滤波',
      formula: ['φ_e = φ_ref − φ_fb'],
      meaning: '参考与反馈的相位差；闭环调节使 φ_e → 0，即锁定。',
      value: (s) => (s.pll.locked ? '已锁定（φ_e → 0）' : '未锁定'),
    },
    'sig-pc': {
      title: 'φ_c · 控制电压',
      kind: '信号',
      io: '环路滤波 → VCO',
      formula: ['φ_c = K_p·φ_e + K_i·∫φ_e dt'],
      meaning: '决定 VCO 频率修正量；环路带宽与阻尼由此确定。',
      value: () => 'K_p / K_i 决定带宽与阻尼',
    },
    out: {
      title: 'f_vco · 输出比特时钟',
      kind: '信号',
      io: 'VCO → 时钟树',
      formula: ['f_vco = N·f_REF'],
      meaning: '倍频后的高速时钟，供发送与采样使用；jitter 直接叠加在时钟边沿上。',
      value: (s) => `${n1(s.pll.freqGHz)} GHz · jitter ${s.pll.jitterPs} ps`,
    },
    fb: {
      title: 'f_fb · 分频反馈',
      kind: '信号',
      io: 'VCO → ÷N → PD',
      formula: ['f_fb = f_vco / N', 'N = f_rate / f_REF'],
      meaning: '分频器把 VCO 频率降回参考量级，与 REF 比较形成闭环，实现 N 倍频。',
      value: (s) => `N = ${Math.round(s.rateGts / (s.refClk.freqMHz / 1000))}`,
    },
  },
  pm: {
    platform: {
      title: '平台 / ACPI · 电源与时钟域',
      kind: '平台',
      io: 'Vcc / Vaux / REF CLK / PERST# → RP',
      formula: [
        'Vcc：主电源，D3cold 时移除',
        'Vaux：辅助电源，L2 / D3cold 保持，供 Beacon / WAKE# 检测',
        'PERST#：电源稳定后释放，触发 Fundamental Reset',
        'REF CLK：100 MHz 差分时钟，L1.1 起可被平台关闭',
      ],
      meaning: '平台掌握电源域与参考时钟。设备能进入多深的低功耗状态、能被哪种信号唤醒，取决于平台是否保留 Vaux、是否支持 Beacon 检测与时钟门控。',
      value: (s, sim) => `${sim.pm.auxPower ? 'Vaux 有' : 'Vaux 无'} · D 状态 ${sim.pm.dstate}`,
    },
    rp: {
      title: 'RP 控制器 · LTSSM 与 Slot Control',
      kind: 'RP',
      io: 'LTSSM / ASPM ↔ 链路；Slot Control ↔ 槽位',
      formula: [
        'LTSSM：L0 → L0s / L0p / L1 / L2 的进入与退出',
        'ASPM：由链路两端自主协商 L0s / L1',
        'Slot Control / Slot Status：热插拔电源、指示灯、DLLSC',
        'DPC / AER：错误隔离与上报（与 PM 独立）',
      ],
      meaning: 'RP 控制器是链路与槽位的控制点：它驱动 LTSSM 完成低功耗握手，也通过 Slot Control 控制槽位电源与热插拔事件。',
      value: (s, sim) => `链路 ${sim.link.ports.RC.state} · SLOT ${sim.hotplug.enabled ? (sim.hotplug.presence === 'present' ? '在位' : '空槽') : '未启用'}`,
    },
    'rp-ctrl': {
      title: 'RP 控制器 ↔ RP PHY · 并行总线',
      kind: '信号',
      io: '控制器 ↔ PHY',
      formula: ['并行数据 + 控制状态', '发送：PCS 编码后送 SerDes', '接收：SerDes 恢复后回送 PCS'],
      meaning: '控制器把要发送的符号交给 PHY 串行化，PHY 把恢复出的符号交回控制器；链路低功耗状态最终通过这条总线体现在 PHY 上。',
      value: (s, sim) => `链路 ${sim.link.ports.RC.state}`,
    },
    rpphy: {
      title: 'RP PHY · 发送 / 接收模拟前端',
      kind: 'PHY',
      io: 'RP 控制器 ↔ 差分对',
      formula: [
        'SerDes：并行 ↔ 串行转换',
        'PLL：REF CLK ×N → 比特时钟',
        'CDR：从数据恢复采样时钟',
        'EIOS / FTS：L0s / L0p 的进入与退出',
      ],
      meaning: 'RP PHY 把并行数据串行化后驱动到通道，并从接收数据恢复时钟；L0s / L0p 的电气空闲和 FTS 恢复都发生在这一层。',
      value: (s, sim) => `${sim.phy.rateGts} GT/s · ${sim.phy.pll.locked ? 'PLL 锁定' : 'PLL 未锁定'}`,
    },
    epphy: {
      title: 'EP PHY · 设备侧发送 / 接收前端',
      kind: 'PHY',
      io: 'EP 控制器 ↔ 差分对',
      formula: [
        '接收：CDR + 均衡恢复数据',
        '发送：把回环 / 响应数据串行化',
        '低功耗：随 L 状态进入电气空闲',
      ],
      meaning: 'EP PHY 与 RP PHY 对称，负责设备侧的串并转换与时钟恢复；唤醒后它需要重新完成 CDR 锁定才能接收 TS1。',
      value: (s, sim) => `${sim.phy.rateGts} GT/s · CDR ${cdrText(sim.phy.cdr.state)}`,
    },
    slot: {
      title: 'Slot / 连接器 · 机械与电气接口',
      kind: '槽位',
      io: 'RP PHY ↔ 金手指 ↔ EP PHY',
      formula: [
        'PRSNT#：插卡在位检测',
        'ATNBTN#：Attention Button',
        'Power Controller：槽位电源开关',
        'PERST# / REF CLK / 边带均经连接器',
      ],
      meaning: '槽位是板级电气与机械的交汇点：数据差分对、电源、参考时钟和边带都经过连接器，热插拔事件也从这里产生。',
      value: (s, sim) => `${sim.hotplug.enabled ? (sim.hotplug.presence === 'present' ? '在位' : '空槽') : '无热插拔'} · 电源 ${sim.hotplug.powerController}`,
    },
    refclk: {
      title: 'REF CLK · 100 MHz 参考时钟到 EP',
      kind: '时钟',
      io: '平台时钟生成器 → 连接器 → PHY REFCLK',
      formula: [
        '平台参考时钟生成器 → REFCLK（100 MHz 差分，SSC 可选）→ PHY PLL',
        'PLL 输出 max_pclk；clk divider / test mux → pclk → pipe_clk（PCLK as PHY Input）',
        'Fixed MAXPCLK：按 pm_div_max_pclk_ratio[5:0] 分频 max_pclk 得到 pclk',
        'Dynamic MAXPCLK：无分频器，pclk 直接由 max_pclk 驱动',
        'Fixed Ratio MAXPCLK：分频比固定为 2',
        'PHY → 控制器：phy_ref_clk_req_n（要参考时钟）、phy_clk_req_n（要 PCLK）',
        '控制器 → PHY：phy_mac_pclkchangeok / mac_phy_pclkchangeack 完成 pclk 变更握手',
        'L1.1 关 REFCLK → PLL 失锁；L1.2 进一步门控 PHY 电源，靠 aux_clk 维持',
      ],
      meaning: 'REFCLK 由平台参考时钟生成器经 CLKREQ# 门控后送入 PHY。PHY 的 PLL 倍频出 max_pclk，再由 clk divider / test mux 分出 pclk 与 pipe_clk 供控制器使用；三种 PCLK 模式决定分频来源。L1.1 关闭 REFCLK 后 PLL 失锁，必须先取回时钟、等 PLL 重新锁定，链路才能进 Recovery。',
      value: (s, sim) => `${sim.phy.refClk.freqMHz} MHz · ${sim.phy.pll.locked ? 'PLL 锁定' : 'PLL 未锁定'}`,
    },
    clkreq: {
      title: 'CLKREQ# · 设备请求参考时钟',
      kind: '边带',
      io: 'EP → 三态缓冲 → 平台时钟生成器',
      formula: [
        '开漏、低有效；R_pu 上拉到 Vaux 3.3V，默认高',
        'EP：device_type strap = 0 → 三态缓冲使能，驱动 CLKREQ# 到平台',
        'RP：device_type strap = 1 → 缓冲关闭，CLKREQ# 只作输入',
        '平台：CLKREQ# = 0 → 打开 REFCLK；全部释放且链路空闲 → 关 REFCLK（L1.1）',
        '控制器 ↔ PHY 回环：local_ref_clk_req_n ↔ phy_ref_clk_req_n',
        'L1 子状态使能（cfg_l1_sub_en）时，EP 在 Recovery 必须拉低 CLKREQ#；L1 之外恒为低',
        'aux_clk_active = 0 → 控制器停在 L1 子状态，保持 phy_pclkreq_n = 0',
        'L2 下无效（无时钟可比）',
      ],
      meaning: 'CLKREQ# 是一条闭环：EP 经三态缓冲拉低 → 平台打开 REFCLK → PLL 锁定 → Recovery。缓冲由 device_type strap 控制，只有 EP 会驱动；线上 R_pu 保证释放时为高。控制器与 PHY 之间还有并行的时钟请求链（local_ref_clk_req_n / phy_ref_clk_req_n），aux_clk_active 则表示 pipe_clk 是否已切到 aux_clk——未切换时控制器不会推进 L1.1 / L1.2。',
      value: (s, sim) => `链路 ${sim.link.ports.RC.state} · REF CLK ${sim.phy.refClk.freqMHz} MHz`,
    },
    clkgate: {
      title: 'CLKREQ# → REF CLK 门控（RP / EP）',
      kind: '门控',
      io: 'CLKREQ#（RP / EP 线与）+ 链路空闲 → REF CLK EN → REFCLK → PHY PLL',
      figure: `<svg viewBox="0 0 620 186" xmlns="http://www.w3.org/2000/svg">
        <rect x="86" y="26" width="320" height="86" rx="8"
          fill="rgba(245,158,11,0.06)" stroke="#f59e0b" stroke-opacity="0.45" stroke-dasharray="5 4"/>
        <text class="arch-note" x="96" y="18" fill="#f59e0b">平台 / Board（参考时钟生成在平台侧）</text>
        <rect x="410" y="26" width="202" height="86" rx="8"
          fill="rgba(56,189,248,0.05)" stroke="#38bdf8" stroke-opacity="0.4" stroke-dasharray="5 4"/>
        <text class="arch-note" x="604" y="18" text-anchor="end" fill="#38bdf8">PHY</text>

        <line x1="88" y1="36" x2="112" y2="36" stroke="#c4b5fd" stroke-width="1.6"/>
        <text class="arch-note" x="116" y="40" fill="#c4b5fd">Vaux 3.3V</text>
        <line x1="100" y1="36" x2="100" y2="42" stroke="#c4b5fd" stroke-width="1.1"/>
        <rect x="96" y="42" width="8" height="10" rx="2" fill="#0d1a2d" stroke="#c4b5fd"/>
        <line x1="100" y1="52" x2="100" y2="76" stroke="#c4b5fd" stroke-width="1.1"/>
        <text class="arch-note" x="116" y="56" fill="#c4b5fd">R_pu 上拉</text>

        <text class="arch-note" x="4" y="68">RP CLKREQ#</text>
        <text class="arch-note" x="4" y="92">EP CLKREQ#</text>
        <line x1="76" y1="64" x2="100" y2="64" stroke="#c4b5fd" stroke-width="1.1"/>
        <line x1="76" y1="88" x2="100" y2="88" stroke="#c4b5fd" stroke-width="1.1"/>
        <line x1="100" y1="64" x2="100" y2="88" stroke="#c4b5fd" stroke-width="1.1"/>
        <circle cx="100" cy="76" r="2.2" fill="#c4b5fd"/>
        <line x1="100" y1="76" x2="132" y2="76" stroke="#c4b5fd" stroke-width="1.1"/>
        <polygon points="136,76 128,72 128,80" fill="#c4b5fd"/>
        <rect x="136" y="60" width="84" height="46" rx="7" fill="#0f1e33" stroke="#fbbf24" stroke-opacity="0.75"/>
        <text class="arch-note" x="178" y="80" text-anchor="middle" fill="#fbbf24">时钟门控</text>
        <text class="arch-note" x="178" y="96" text-anchor="middle" fill="#fbbf24">CLKREQ# ∧ Idle</text>
        <text class="arch-note" x="4" y="132">链路空闲</text>
        <path d="M58,128 H112 V106 H132" fill="none" stroke="#94a3b8" stroke-width="1.1"/>
        <polygon points="136,106 128,102 128,110" fill="#94a3b8"/>

        <line x1="220" y1="83" x2="280" y2="83" stroke="#fbbf24" stroke-width="1.2"/>
        <polygon points="286,83 278,79 278,87" fill="#fbbf24"/>
        <text class="arch-note" x="253" y="97" text-anchor="middle" fill="#fbbf24">REF CLK EN</text>

        <rect x="286" y="60" width="104" height="46" rx="7" fill="#0f1e33" stroke="#fbbf24" stroke-opacity="0.6"/>
        <text class="arch-note" x="338" y="80" text-anchor="middle" fill="#fbbf24">平台时钟生成</text>
        <text class="arch-note" x="338" y="96" text-anchor="middle">REFCLK 100 MHz</text>

        <line x1="390" y1="83" x2="410" y2="83" stroke="#fbbf24" stroke-width="1.2"/>
        <polygon points="416,83 408,79 408,87" fill="#fbbf24"/>
        <rect x="416" y="60" width="68" height="46" rx="7" fill="#0f1e33" stroke="#fbbf24" stroke-opacity="0.6"/>
        <text class="arch-note" x="450" y="80" text-anchor="middle" fill="#fbbf24">PHY PLL</text>
        <text class="arch-note" x="450" y="96" text-anchor="middle">max_pclk</text>

        <line x1="484" y1="83" x2="504" y2="83" stroke="#fbbf24" stroke-width="1.2"/>
        <polygon points="510,83 502,79 502,87" fill="#fbbf24"/>
        <rect x="510" y="60" width="92" height="46" rx="7" fill="#0f1e33" stroke="#fbbf24" stroke-opacity="0.6"/>
        <text class="arch-note" x="556" y="80" text-anchor="middle" fill="#fbbf24">clk divider</text>
        <text class="arch-note" x="556" y="96" text-anchor="middle">pclk · pipe_clk</text>

        <text class="arch-note" x="4" y="152" fill="#7f95b3">链路空闲来自 LTSSM：L0 且无待发 TLP / 无训练</text>
        <text class="arch-note" x="4" y="166" fill="#7f95b3">门控与参考时钟生成在平台侧；REFCLK 送入 PHY 后由 PLL / 分频得到 pclk · pipe_clk</text>
      </svg>`,
      formula: [
        'RP / EP 的 CLKREQ# 为开漏输出，R_pu 上拉到 Vaux 3.3V 并做线与',
        '任一设备拉低 → CLKREQ# = 0 → 请求 REF CLK 保持开启',
        '全部释放 → 被上拉为 1 → 允许平台关闭 REF CLK',
        'REF_CLK_EN = (CLKREQ# = 1) ∧ 链路空闲',
        '链路空闲来自 LTSSM：链路处于 L0 且无待发 TLP / 无进行中的训练',
        'REF CLK EN = 1 → 平台参考时钟生成输出 REFCLK 100 MHz',
        'REFCLK 进 PHY PLL 倍频出 max_pclk，再经 clk divider / test mux 得到 pclk / pipe_clk',
        '门控对象：RP PHY 与“Slot → EP PHY”的 100 MHz REF CLK',
        '位置：线与、R_pu、时钟门控与 REFCLK 生成都在平台侧；PLL / 分频在 PHY 侧',
        'L1.1 / L1.2 关闭 REF CLK；L2 / L3 主电源关闭，时钟已无意义',
      ],
      meaning: '这是“请求—门控”的闭环：上拉电阻保证释放时为高电平（默认允许省电），开漏线与保证任一设备都能把时钟要回来；平台只有在 CLKREQ# 为高且链路空闲时才真正关时钟。“链路空闲”不是 CLKREQ# 自己产生的信号，而是取自 LTSSM 的状态：链路在 L0 且没有待发 TLP、没有进行中的训练。唤醒时 EP 先拉低 CLKREQ#，REF CLK 恢复并等 PLL 锁定后，链路才能进入 Recovery。',
      value: (s, sim) => {
        const locked = sim.phy.pll.locked ? 'PLL 锁定' : 'PLL 未锁定';
        return `链路 ${sim.link.ports.RC.state} · ${locked} · REF CLK ${sim.phy.refClk.freqMHz} MHz`;
      },
    },
    ep: {
      title: 'EP / 设备 · PMCSR 与 D / P 状态',
      kind: 'EP',
      io: 'PMCSR → D 状态；D 状态 → 链路请求',
      formula: [
        'PMCSR.PowerState[1:0]：00=D0，01=D1，10=D2，11=D3hot',
        'PME_En / PME_Status：允许发 PME、记录挂起',
        'No_Soft_Reset：D3hot→D0 是否需要重新初始化',
        'CLKREQ#：设备请求参考时钟的边带输出',
        'D0 工作态（D0uninitialized → D0active）· D1 轻睡眠（可选）· D2 深睡眠（可选）· D3hot 主电源保持 · D3cold 仅 Vaux',
        'P0 / P1 / P2：PIPE PowerDown 编码（00 / 01 / 10），由 PHY 实现，不是软件可见的性能档',
      ],
      meaning: '设备通过 PMCSR 接受软件的 D 状态命令（软件可见、可控制）；P 状态由 PHY 内部按 PIPE 编码实现，软件不直接控制，也不能与 L1 / L2 画等号。',
      value: (s, sim) => `${sim.pm.dstate} · ${P_STATES[sim.pm.pstate].name} · ${sim.pm.powerW.toFixed(1)} W`,
    },
    dstate: {
      title: 'D 状态 · 设备电源状态',
      kind: '状态',
      io: 'PMCSR.PowerState → D0…D3cold',
      formula: [
        'D0：工作态，全功能可用（D0uninitialized → D0active）',
        'D1：轻睡眠（可选实现），保留大部分上下文，仅关部分时钟',
        'D2：深睡眠（可选实现），关闭更多单元、丢失更多上下文',
        'D3hot：主电源保持，配置空间可访问，写 PMCSR 回 D0 且无需复位',
        'D3cold：主电源移除、仅 Vaux，必须 Fundamental Reset 或重新上电',
        '推导：D0 → L0 / L0s / L0p / L1；D1 / D2 → L1；D3hot → L1 / L2/L3 Ready；D3cold → L2 / L3',
      ],
      meaning: 'D 状态是软件视角的设备功耗级别（软件可见）；L 状态由 D 状态与 ASPM 推导，两者不是同一个状态。D3hot ≠ L3：D3hot 时 Vcc 与 LTSSM 仍在，可写 PMCSR 回 D0；L3 时 LTSSM 已断电。',
      value: (s, sim) => `${sim.pm.dstate} · ${sim.pm.powerW.toFixed(1)} W`,
    },
    lstate: {
      title: 'L 状态 · 链路电源状态',
      kind: '状态',
      io: 'D 状态 + ASPM → L0…L3',
      formula: [
        'L0：正常工作态，TLP / DLLP 全速传输，REF CLK 与 PLL 全开',
        'L0s：待机态（仅 Non-Flit），EIOS 进入、FTS 快速退出',
        'L0p：Flit 模式（Gen6），只关空闲 Lane 子集，其余继续传 Flit',
        'L1：低功耗待机，主电源与上下文保持，退出走 Recovery',
        'L1ss（L1.0 / L1.1 / L1.2）：按关闭 REF CLK 与 PLL 的深度分档',
        'L2：睡眠，主电源与时钟关闭、仅 Vaux，退出全量重训练',
        'L3：完全断电，上电 + Fundamental Reset 才能回到 Detect，此时 LTSSM 已断电',
      ],
      meaning: 'L 状态由 D 状态与 ASPM 推导、LTSSM 执行，软件通常不可见；它描述链路能否传数据、时钟与上下文是否保留，决定唤醒路径的长度。',
      value: (s, sim) => sim.link.ports.RC.state,
    },
    wake: {
      title: '唤醒源 · CLKREQ# / Beacon / WAKE# / PME',
      kind: '机制',
      io: 'EP → RP / 平台：边带与消息',
      formula: [
        'CLKREQ#：开漏低有效，L1 要回 REF CLK',
        'Beacon：L2 下 Vaux 供电，差分对低频脉冲串',
        'WAKE#：开漏低有效，直接请求主电源',
        'PM_PME：Message 0x18，只上报原因',
      ],
      meaning: '唤醒源与低功耗深度一一对应：L1 用 CLKREQ#，L2 用 Beacon 或 WAKE#；PM_PME 只有在链路可用后才发得出去。',
      value: (s, sim) => `PME ${sim.pm.pmeEn ? (sim.pm.pmeStatus ? '挂起' : '使能') : '关闭'}`,
    },
    pwr: {
      title: '电源 / 时钟 / 复位通路',
      kind: '信号',
      io: '平台 → RP / EP',
      formula: ['Vcc：主电源 3.3 V / 12 V', 'Vaux：辅助电源，低功耗保持', 'REF CLK：100 MHz 差分', 'PERST#：低有效复位'],
      meaning: '这组通路决定设备能否被唤醒：Vaux 在 L2 / D3cold 下保持，REF CLK 在 L1.1 起可关闭，PERST# 在电源稳定后释放。',
      value: () => 'Vcc / Vaux / REF CLK / PERST#',
    },
    link: {
      title: '链路 · L0 / L1 / L2',
      kind: '信号',
      io: 'RP ↔ EP',
      formula: [
        'L0：正常工作态，TLP / DLLP 全速传输',
        'L0s / L0p：链路空闲时进入，FTS 快速恢复（L0s 仅 Non-Flit、L0p 仅 Flit）',
        'L1 / L1ss：低功耗待机，时钟与 PLL 可按子状态关闭，退出走 Recovery',
        'L2 / L3：主电源与时钟关闭，链路不可用，退出需全量重训练',
      ],
      meaning: '链路状态决定了唤醒后的恢复路径：L1 退出走 Recovery，L2 退出必须从 Detect 重新训练。',
      value: (s, sim) => sim.link.ports.RC.state,
    },
    sideband: {
      title: '边带与消息 · CLKREQ# / Beacon / WAKE# / PM_PME',
      kind: '信号',
      io: 'EP → RP / 平台',
      formula: ['CLKREQ#：请求参考时钟', 'Beacon：L2 唤醒信标', 'WAKE#：请求主电源', 'PM_PME：唤醒原因上报'],
      meaning: '链路停止传输后仍需要一类“带外/带内”的手段把系统叫醒；这组信号就是低功耗与正常工作之间的桥梁。',
      value: (s, sim) => `当前链路 ${sim.link.ports.RC.state}`,
    },
    dmap: {
      title: 'D → L 映射',
      kind: '映射',
      io: 'D 状态 → L 状态（推导）',
      formula: [
        'D0 → L0 / L0s / L0p / L1',
        'D1 / D2 → L1',
        'D3hot → L1 / L2/L3 Ready（≠ L3）',
        'D3cold → L2 / L3（LTSSM 断电）',
      ],
      meaning: '映射只是“软件策略 → 链路硬件状态”的推导关系，不是状态等价：D0 可在 L0 / L0s / L1 / L0p；D3hot 不等于 L3，L3 时 LTSSM 已断电。',
      value: (s, sim) => `${sim.pm.dstate} → ${sim.link.ports.RC.state}`,
    },
    lwake: {
      title: 'L → 唤醒源',
      kind: '映射',
      io: 'L 状态 → 唤醒机制',
      formula: ['L0s → FTS', 'L1.0–L1.2 → CLKREQ#', 'L2 / L3 → Beacon / WAKE#'],
      meaning: '链路越深，唤醒所需的外部配合越多：L0s 只需 FTS，L1 需要时钟恢复，L2 需要平台恢复主电源并重新训练。',
      value: (s, sim) => sim.link.ports.RC.state,
    },
  },
  ras: {
    detect: {
      title: '检测 · PHY / DL / TL',
      kind: '环节',
      io: '线路 / TLP → 错误指示',
      formula: [
        'PHY：编码违例 / Disparity / Lane 失步 → 重训',
        'DL：LCRC + 序列号 → NAK / Replay',
        'TL：ECRC、Poisoned TLP、Completion Timeout → 错误状态位',
      ],
      meaning: '错误在最靠近发生点的层次被发现：能被重传或纠正的留在低层处理，只有无法纠正的才逐层上报，避免把可自愈错误升级成 Fatal。',
      value: (s, sim) => {
        const a = sim.aer.snapshot();
        return `AER 纠正 ${a.correctable} · Non-Fatal ${a.nonfatal} · Fatal ${a.fatal}`;
      },
    },
    severity: {
      title: '分级 · AER Severity',
      kind: '判定',
      io: '错误类型 → Correctable / Non-Fatal / Fatal',
      formula: [
        'Correctable Error Status → ERR_COR',
        'Uncorrectable Error Severity → ERR_NONFATAL / ERR_FATAL',
        'Severity 可由软件按位配置',
      ],
      meaning: '分级决定后续动作：可纠正的错误只计数，Non-Fatal 交给驱动恢复，Fatal 才允许复位链路。同一错误在不同策略下可以被划到不同级别。',
      value: (s, sim) => {
        const a = sim.aer.snapshot();
        if (a.fatal > 0) return '当前出现过 Fatal';
        if (a.nonfatal > 0) return '当前出现过 Non-Fatal';
        return a.correctable > 0 ? '仅 Correctable' : '无错误';
      },
    },
    report: {
      title: '上报 · ERR_* Message / AER 日志',
      kind: '机制',
      io: 'EP / 端口 → RC → 系统',
      formula: [
        'ERR_COR / ERR_NONFATAL / ERR_FATAL Message（带内，路由到 RC）',
        'AER Header Log + Source ID 定位出错 TLP',
        'Root Complex Event Collector 汇总',
        'RC 把错误 Message 转为主机中断（模型记为 MSI Vector 0）',
      ],
      meaning: '上报只负责把“发生了什么、发生在谁身上”告诉系统，不改变链路状态。错误 Message 本身不是 MSI：它由 EP 发出、路由到 RC，RC 再转成主机中断交给 AER 处理程序；是否复位由软件策略决定。',
      value: (s, sim) => `日志 ${sim.aer.snapshot().log.length} 条`,
    },
    contain: {
      title: '隔离 · DPC / Egress Control',
      kind: '机制',
      io: '下游端口 → 阻塞链路',
      formula: [
        '不可纠正错误 → DPC Triggered',
        'Egress Control：阻止下游 TLP 继续下泄',
        'RP PIO：为未转发请求生成 UR Completion',
      ],
      meaning: 'DPC 的价值是把故障限制在端口以下：错误 TLP 不再进入上游，主机与其它设备继续工作；它本身不修复错误，只创造可恢复的边界。',
      value: (s, sim) => {
        const d = sim.dpc.snapshot();
        return `${d.state}${d.reason ? ` · ${d.reason}` : ''} · 丢弃 ${d.blocked} · UR ${d.urCompletions}`;
      },
    },
    recover: {
      title: '恢复 · FLR / Hot Reset / 热插拔',
      kind: '动作',
      io: '软件 / 平台 → 设备或链路',
      formula: [
        'FLR：仅复位单个 Function',
        'Hot Reset / SBR：复位链路或总线，重新训练',
        'Hot-Plug：重新上电 + 枚举（最彻底）',
      ],
      meaning: '恢复动作按代价递增选择：先尝试功能级复位，失败再链路级复位，仍不可用才换卡。动作越重，t_reset 与 t_retrain 越大。',
      value: (s, sim) => `DPC ${sim.dpc.snapshot().state} · 链路 ${sim.link.ports.RC.state}`,
    },
  },
  doe: {
    'doe-sw': {
      title: '系统固件 / 软件 · DOE 发起者',
      kind: '软件',
      io: '配置空间 → DOE 邮箱',
      formula: [
        'CfgWr：每次写 1 DW 到 Write Data Mailbox',
        'CfgWr：写 Control.Go = 1 启动',
        'CfgRd：每次读 1 DW 从 Read Data Mailbox',
      ],
      meaning: 'DOE 完全由配置请求驱动，没有自己的 TLP 类型；因此只能在配置空间可访问之后使用，也无法在 Function 之间直接 P2P。',
      value: '逐 DW、全字节使能',
    },
    'doe-cfg': {
      title: '配置请求通路',
      kind: '通路',
      io: '软件 ↔ Function 配置空间',
      formula: ['CfgWr / CfgRd 均为 Non-Posted', '每次完成对应一个 DW 的搬运'],
      meaning: '每次邮箱访问都要等 Completion，所以 DOE 的往返延迟远高于突发 TLP；它适合小数据对象与管理命令，不适合大数据搬运。',
      value: '1 DW / 次',
    },
    'doe-regs': {
      title: 'DOE 扩展能力寄存器块',
      kind: '寄存器',
      io: '配置空间 +00h … +14h',
      formula: [
        '+00h Capability Header / +04h Capabilities',
        '+08h Control：Go、Abort、Interrupt Enable',
        '+0Ch Status：Busy、Data Object Ready、Error',
        '+10h Write Data Mailbox / +14h Read Data Mailbox',
      ],
      meaning: '邮箱是单缓冲：写侧与读侧各一个 32-bit 窗口，靠 Go / Busy / Ready 三个握手位串行化整个数据对象。',
      value: '24 B · 6 个寄存器',
    },
    'doe-object': {
      title: '数据对象（Data Object）',
      kind: '数据',
      io: '软件 → DOE 实例',
      formula: [
        'DW0：Vendor ID [15:0] + Data Object Type [23:16]',
        'DW1：Length [17:0] + Connection ID [29:18]',
        '长度 2 DW … 2^18 DW；0001h 非法',
      ],
      meaning: '类型由 Vendor ID + Type 两级命名；长度不符时整个对象被静默丢弃，过长则只处理期望部分。',
      value: '2 DW 起',
    },
    'doe-engine': {
      title: 'DOE 实例 · 解析与分发',
      kind: '硬件',
      io: '数据对象 → 特性实现',
      formula: [
        '检查 Busy、接收完整对象、置 Busy=1',
        '解析 DW0 / DW1，按 Type 交给特性',
        '1 s 内完成：Ready=1；否则 Error=1',
      ],
      meaning: '一个 Function 可以有多个 DOE 实例；同一实例同一时间只处理一个数据对象，多个 feature 必须由软件串行化。',
      value: '1 s 完成时限',
    },
    'doe-feature': {
      title: 'DOE 特性',
      kind: '能力',
      io: '数据对象 → 具体功能',
      formula: [
        'Discovery（00h）：必须实现，枚举类型',
        'CMA-SPDM（01h / 02h）：认证与安全会话',
        'IDE_KM：经安全会话编程 IDE 密钥',
        'Async Message（05h）：设备主动上报',
      ],
      meaning: 'DOE 本身只是传输层；真正做什么由特性定义。Discovery 让软件在不预先知道实现的情况下枚举其余类型。',
      value: 'Discovery 必选',
    },
    'doe-io': {
      title: 'DOE → Function 内部',
      kind: '通路',
      io: '数据对象 → 度量 / 密钥 / 配置',
      formula: ['数据对象由 Function 内部逻辑消费', '结果通过同一邮箱返回'],
      meaning: '特性实现可以访问设备内部的度量、密钥库或配置；DOE 不规定内部实现，只规定邮箱与数据对象格式。',
      value: '实现相关',
    },
    'doe-consumer': {
      title: 'Function 内部 · 特性实现',
      kind: '硬件',
      io: 'DOE 数据对象 ↔ 设备内部',
      formula: ['认证与度量结果', '密钥写入 / 状态查询', '设备配置与调试接口'],
      meaning: 'DOE 提供标准化入口，但具体能力与安全边界由设备实现；规范只要求 Discovery 可用。',
      value: '由特性定义',
    },
  },
  ide: {
    'ide-plain': {
      title: 'TL 明文 TLP',
      kind: '信号',
      io: 'TL → IDE 引擎',
      formula: ['A = IDE Prefix / OHC-C ‖ Header', 'P = TLP Data Payload'],
      meaning: '进入 IDE 引擎前是普通 TLP；IDE 把 Header 当作附加认证数据（不加密），只加密数据载荷。',
      value: 'A / P 分离',
    },
    'ide-in': {
      title: 'TLP 进入 IDE 引擎',
      kind: '通路',
      io: 'TL → IDE TX',
      formula: ['按 Stream 关联规则选择 TLP', 'Link IDE：除 Selective 外的全部 TLP', 'Selective IDE：按 Stream_ID 等规则选定'],
      meaning: '先判定 TLP 属于哪条流、哪个子流，再决定使用哪套密钥；不属于任何流的 TLP 走普通路径。',
      value: '按流关联',
    },
    'ide-gcm': {
      title: 'IDE TX · AES-GCM',
      kind: '运算',
      io: 'A / P → C + MAC',
      formula: [
        'C = GCTR_K(IV, P)',
        'MAC = GHASH_H(A, C) ⊕ E_K(J0)',
        'MAC 长度固定 96 b',
      ],
      meaning: 'AES-GCM 同时提供机密性与完整性：载荷被加密，头部与密文一起被认证；任何一位改动都会让 MAC 不匹配。',
      value: 'AES-GCM · 96 b MAC',
    },
    'ide-enc': {
      title: '加密输出',
      kind: '信号',
      io: '明文 P → 密文 C',
      formula: ['|C| = |P|（CTR 模式不改变长度）', 'MAC 附在 TLP 上，计入 Header Credit'],
      meaning: '密文与明文等长；额外开销只有前缀、MAC 与可选 PCRC。MAC 不是数据载荷，流控上按 Header Credit 计算。',
      value: '长度不变',
    },
    'ide-wire': {
      title: '线上 IDE TLP',
      kind: '信号',
      io: 'IDE TX → 链路',
      formula: [
        'NFM：IDE Prefix（1 DW）+ Header + C + MAC',
        'FM：OHC-C + Header + C + Trailer（MAC / PCRC）',
      ],
      meaning: '接收端靠前缀 / OHC-C 识别流与子流；同一对 Partner 端口必须同为 NFM 或同为 FM，否则按 Misrouted IDE TLP 处理。',
      value: '4 B + 12 B',
    },
    'ide-link': {
      title: 'IDE 流标识与密钥选择',
      kind: '机制',
      io: '前缀 / OHC-C → 密钥库',
      formula: ['Stream_ID[7:0] + Sub-Stream[2:0]', 'K 位选择 K0 / K1 密钥集'],
      meaning: 'Stream ID 决定用哪条流的密钥，Sub-Stream 决定具体子流，K 位支持不中断业务地切换密钥。',
      value: 'Stream + 子流 + K 位',
    },
    'ide-link2': {
      title: '物理链路 · 威胁模型',
      kind: '环境',
      io: '两个 IDE 端点之间',
      formula: [
        '可被窃听：分析仪 / 中间板 / 流氓 Retimer',
        '可被篡改：增删 TLP、改内容、重排',
        '可被替换：伪装成已认证设备',
      ],
      meaning: 'IDE 假设链路可被物理攻击，因此必须同时保证机密性、完整性与重放保护；认证后的密钥让伪装设备无法生成合法 IDE TLP。',
      value: '链路是攻击面',
    },
    'ide-rx': {
      title: 'IDE RX · 校验与解密',
      kind: '运算',
      io: 'C / MAC → 明文 TLP',
      formula: ['重算 GHASH 并比较 MAC', 'MAC 一致 → 解密并交付', 'MAC 不符 → 丢弃 + IDE Check Failed'],
      meaning: '接收端先认证再解密，绝不把未通过校验的数据交给上层；PCRC 再额外检查加解密逻辑是否出错。',
      value: '先验后解',
    },
    'ide-ctrl': {
      title: '系统固件 / 软件 · 中央权威',
      kind: '软件',
      io: '配置寄存器 + 密钥编程',
      formula: [
        '配置 IDE Extended Capability（ID 0030h）',
        '选择算法、PCRC、聚合、TC 与 Stream ID',
        '触发两端 IDE_KM，最后置 Stream Enable',
      ],
      meaning: '系统软件是密钥与配置的唯一来源，必须保证密钥只经安全会话传输；平台信任策略本身不在 IDE 规范范围内。',
      value: '配置 + 密钥',
    },
    'ide-spdm': {
      title: 'SPDM 安全会话',
      kind: '协议',
      io: 'Requester ↔ Responder',
      formula: ['GET_VERSION / CAPABILITIES / ALGORITHMS', '证书 / 度量 / KEY_EXCHANGE / FINISH', '之后的消息在安全会话内传递'],
      meaning: '先认证对端身份并建立加密会话，后续 IDE_KM 才可信；没有这一步，密钥可能被中间人替换。',
      value: '认证 + 加密',
    },
    'ide-spdm2': {
      title: 'DOE + CMA-SPDM',
      kind: '传输',
      io: 'DOE 数据对象 01h / 02h',
      formula: ['01h：CMA-SPDM（明文会话建立）', '02h：Secured CMA-SPDM（安全会话）', '也可经 MCTP / SMBus 传输'],
      meaning: 'DOE 是 IDE 密钥管理最常见的带内传输；RC 直连 EP 时，主机通过 DOE 与 EP 的上游端口完成 SPDM 与 IDE_KM。',
      value: '01h / 02h',
    },
    'ide-km': {
      title: 'IDE_KM 协议',
      kind: '协议',
      io: 'Requester → Responder',
      formula: [
        'QUERY / QUERY_RESP：按 PortIndex 查询能力',
        'KEY_PROG / KP_ACK：256 b Key + 64 b IFV，每条流 6 次',
        'K_SET_GO / K_SET_STOP / K_GOSTOP_ACK：启停 Key Set',
      ],
      meaning: 'IDE_KM 基于 SPDM VENDOR_DEFINED 消息，本身必须放在 Secured-SPDM 中；未受保护的请求必须丢弃且不得响应。',
      value: '256 b × 6 把 / 流',
    },
    'ide-km2': {
      title: 'IDE_KM 数据对象',
      kind: '协议',
      io: '软件 ↔ Partner 端口',
      formula: [
        'DW0：Protocol ID = 00h，Object ID = 00h–06h',
        'KEY_PROG：PortIndex + Stream ID + 子流 + RxTxB + Key Set',
        'K_SET_GO 后 10 ms 内生效；KP_ACK ≤1 s',
      ],
      meaning: '两个 key set 支持热切换：先编程备用 bank，再切 K 位，最后停旧 bank，全程不打断业务。',
      value: 'K0 / K1 双 bank',
    },
    'ide-keys': {
      title: '密钥库',
      kind: '存储',
      io: 'IDE_KM → IDE 引擎',
      formula: [
        '每把密钥 256 b',
        '3 个子流 × Rx / Tx = 6 把 / 流',
        '收发、子流之间不得复用密钥',
      ],
      meaning: '密钥只能存在于受保护存储中，不能出现在调试寄存器或明文缓冲区；旧 bank 在切换后必须标记无效。',
      value: '256 b × 6',
    },
    'ide-keys2': {
      title: '密钥 bank 与 K 位',
      kind: '机制',
      io: 'K 位 → 密钥 bank',
      formula: ['K=0 → bank 0；K=1 → bank 1', '切换后旧 bank 立即失效', '各子流切换互不影响'],
      meaning: 'K 位是数据平面上的换钥信号，不需要停止流；接收端看到 K 位翻转就切换 bank，直到软件重新编程旧 bank。',
      value: '热切换',
    },
    'ide-prefix': {
      title: 'IDE Prefix / OHC-C',
      kind: '字段',
      io: '标识流与密钥',
      formula: [
        'Byte 0：Fmt = 1001b，Type = 0010b',
        'Byte 1：PR_Sent_Counter；Byte 2：Stream_ID',
        'Byte 3[7:4]：Sub-Stream；[3]P [2]M [1]K [0]T',
      ],
      meaning: '这是接收端识别 IDE TLP 的唯一入口；NFM 用 1 DW 前缀，FM 把这些字段放进 OHC-C，MAC / PCRC 是否存在由 TS 字段指示。',
      value: '1 DW = 4 B',
    },
    'ide-header': {
      title: 'Header · 附加认证数据（A）',
      kind: '字段',
      io: 'Header → GHASH',
      formula: ['Header 参与 MAC 计算，但不加密', '路由字段保持明文，便于 Switch 转发'],
      meaning: '头部不加密是为了让中间端口仍能路由；机密性由载荷加密提供，完整性由 MAC 覆盖头部与载荷。',
      value: '认证不加密',
    },
    'ide-payload': {
      title: 'Data Payload · 明文 P → 密文 C',
      kind: '字段',
      io: 'P → C',
      formula: ['C = GCTR_K(IV, P)', 'PCRC 可选择随 P 一起加密'],
      meaning: '载荷是唯一被加密的部分；没有载荷的 TLP（如纯读请求）只受 MAC 保护。',
      value: 'CTR 加密',
    },
    'ide-mac': {
      title: 'MAC · 96 b 认证标签',
      kind: '字段',
      io: 'A + C → MAC',
      formula: ['MAC = GHASH_H(A, C) ⊕ E_K(J0)', '固定 96 b = 12 B', '流控按 Header Credit 计'],
      meaning: 'MAC 覆盖前缀 / OHC-C、Header、端到端前缀与密文；聚合时多个 TLP 共用一个 MAC，按聚合单元计算。',
      value: '12 B',
    },
    'ide-out': {
      title: '输出到对端',
      kind: '通路',
      io: 'C + MAC → RX 引擎',
      formula: ['DL 先做 LCRC / 重传，再交给 IDE 校验', 'IDE 校验失败不重传，直接丢弃并报错'],
      meaning: 'IDE 复用 DL 的可靠传输，但 MAC 失败不是链路错误，重传也无法修复，因此按安全错误处理。',
      value: '先 DL 后 IDE',
    },
  },
  tdisp: {
    'tdisp-tvm': {
      title: 'TVM · TEE 虚拟机',
      kind: '软件',
      io: 'TVM 数据 ↔ TDI',
      formula: ['TDI 分配给 TVM 后由 TVM 独占', 'T=1 的 TLP 属于该 TVM', '只有 RUN 才能访问 TDI'],
      meaning: 'TVM 不信任 VMM 与 PF，只信任 TSM 与设备 DSM 提供的安全通道；机密数据只能在 RUN 状态放入 TDI。',
      value: 'TDI 拥有者',
    },
    'tdisp-tvm2': {
      title: '第二个 TVM',
      kind: '软件',
      io: '各自的 TDI ↔ 各自的 IDE 流',
      formula: ['不同 TVM 使用不同 TDI', '同一对端口可共享一条 IDE 流', 'DSM 保证 TDI 之间隔离'],
      meaning: '多个 TVM 可以同时使用同一设备的不同 TDI；彼此的数据靠 T 位、地址检查与设备内部隔离区分，而不是靠多条 IDE 流。',
      value: '独立 TDI',
    },
    'tdisp-legacy': {
      title: 'Legacy VM',
      kind: '软件',
      io: '普通 MMIO / DMA',
      formula: ['隐式信任 VMM', 'TLP 的 T 位为 0', '可共用 IDE 流但不能访问 TVM 机密数据'],
      meaning: 'Legacy VM 与 TVM 可以共存；绑定给 TDISP 的 IDE 流也允许承载非 TDISP TLP，但 DSM 必须阻止它们访问 TVM 数据。',
      value: 'T=0 流量',
    },
    'tdisp-vmm': {
      title: 'VMM · 资源管理',
      kind: '软件',
      io: '配置空间 / PF 接口 → TDI',
      formula: ['锁定前配置 BAR、队列、地址映射', '锁定后不得影响 TDI 安全属性', '通过 PF 驱动管理设备'],
      meaning: 'VMM 与 PF 负责资源管理，但不在 TVM 的 TCB 内；TDISP 要求设备在锁定后检测并拒绝它们的安全相关改动。',
      value: '不在 TVM 的 TCB',
    },
    'tdisp-tsm': {
      title: 'TSM · 主机侧信任代理',
      kind: '软件',
      io: 'TVM ↔ DSM',
      formula: [
        '认证设备并建立 SPDM 安全会话',
        '发起 LOCK / REPORT / START / STOP',
        '绑定 IDE 流并维护 TDI 状态',
      ],
      meaning: 'TSM 代表 TVM 执行 TDISP；它必须保证请求发生在安全会话内，并把 nonce 与 IDE Stream ID 一并绑定到 TDI。',
      value: 'TDISP 发起方',
    },
    'tdisp-mem': {
      title: 'TEE memory',
      kind: '存储',
      io: 'TVM 机密数据',
      formula: ['必须具备机密性机制', '可选提供完整性', 'HPA 由 TA 转换后访问'],
      meaning: 'TEE 内存是 TVM 机密数据的存放处；IDE 只保护链路，内存本身的加密 / 完整性由平台机制保证。',
      value: '机密性必需',
    },
    'tdisp-mem2': {
      title: 'Non-TEE memory',
      kind: '存储',
      io: '可共享数据',
      formula: ['不假定有机密性机制', '对应 IS_NON_TEE_MEM=1 的 MMIO 范围'],
      meaning: '非 TEE 内存可以与非 TVM 实体共享；只有显式标记为 IS_NON_TEE_MEM 的范围才允许 T=0 访问。',
      value: '可共享',
    },
    'tdisp-ta': {
      title: 'TA / IOMMU · 地址转换',
      kind: '硬件',
      io: 'HPA → TDI / 内存',
      formula: ['MMIO 请求按 HPA 路由到 TDI', '维护 IOMMU 翻译与访问控制', '错误路由按攻击处理'],
      meaning: 'TA 把 TVM 的物理地址映射到正确的 TDI 与内存；它和 TSM 一起保证 TLP 不会因为路由错误而绕过访问检查。',
      value: 'HPA 路由',
    },
    'tdisp-pf': {
      title: 'PF · 管理接口',
      kind: '硬件',
      io: 'VMM → TDI 配置',
      formula: ['锁定前可配置 TDI', '锁定后改动被视为安全违规', '不得访问其它 TDI 的机密数据'],
      meaning: 'PF 是资源管理入口，但不是信任根；设备必须把它与 TDI 的机密数据隔离，防止 PF 越权访问。',
      value: '锁定后受限',
    },
    'tdisp-dsm': {
      title: 'DSM · 设备侧信任代理',
      kind: '硬件',
      io: 'TDISP 消息 → TDI',
      formula: [
        '校验消息来自安全会话',
        '执行 LOCK / START / STOP 并维护状态',
        '跟踪配置变化，违规则转 ERROR',
      ],
      meaning: 'DSM 是设备内的安全执行点；它必须独立于 PF，拒绝未受安全保护或状态非法的请求。',
      value: 'TDISP 执行方',
    },
    'tdisp-tdi': {
      title: 'TDI · TEE 设备接口',
      kind: '接口',
      io: '状态机 + T 位',
      formula: ['CONFIG_UNLOCKED → CONFIG_LOCKED → RUN', '任意状态 → ERROR → CONFIG_UNLOCKED', '每个 TDI 有唯一 INTERFACE_ID'],
      meaning: 'TDI 可以是整个设备、非 IOV Function、PF（含下属 VF）或单个 VF；每个 TDI 有独立状态机与绑定 IDE 流。',
      value: '独立状态机',
    },
    'tdisp-tdi2': {
      title: 'TDI · 独立安全域',
      kind: '接口',
      io: 'TVM ↔ 设备资源',
      formula: ['每个 TDI 单独锁定 / 启动 / 停止', 'DSM 只允许有效 TDI 被寻址'],
      meaning: '同一设备内的多个 TDI 可以分别分配给不同 TVM；DSM 必须保证一个 TDI 的操作不会影响另一个 TDI 的安全状态。',
      value: '可多实例',
    },
    'tdisp-tdi3': {
      title: 'TDI · INTERFACE_ID',
      kind: '接口',
      io: 'FUNCTION_ID + Reserved',
      formula: ['FUNCTION_ID：RID[15:0]、Segment[23:16]、RSV[24]', 'Bus / Segment 在 CONFIG_LOCKED / RUN 不得改变'],
      meaning: 'INTERFACE_ID 是 TSM 与 DSM 消息中定位 TDI 的唯一标识；RID 变化会让 TDI 进入 ERROR。',
      value: '12 B',
    },
    'tdisp-atc': {
      title: 'ATC · ATS 翻译缓存',
      kind: '硬件',
      io: 'TDI ↔ TA',
      formula: ['ATS 能力需在设备上使能', 'LOCK / STOP 时失效该 TDI 的翻译', 'P2P 需要 ATS 已启用'],
      meaning: '设备缓存地址翻译以减少往返；锁定与停止时必须让该 TDI 的旧翻译失效，避免继续访问已撤销的映射。',
      value: 'ATS 缓存',
    },
    'tdisp-cert': {
      title: '设备证书与私钥',
      kind: '安全',
      io: 'SPDM 认证 → TSM / TVM',
      formula: ['ModelCert：型号级证书', 'per-part DevPrivKey：每颗芯片独立私钥', 'DevCert：设备证书与度量'],
      meaning: 'TSM 用证书链验证设备身份与固件度量；per-part 私钥让设备无法被另一颗芯片伪装替代。',
      value: '身份与度量',
    },
    'tdisp-statechip': {
      title: 'TDI 的 TDISP 状态',
      kind: '状态',
      io: '每个 TDI 一个实例',
      formula: ['0 = CONFIG_UNLOCKED', '1 = CONFIG_LOCKED', '2 = RUN', '3 = ERROR'],
      meaning: 'DEVICE_INTERFACE_STATE 用 1 B 返回该值，所有其它编码保留；TSM 可在任意状态查询。',
      value: '4 个状态',
    },
    'tdisp-msg': {
      title: 'TSM ↔ DSM 安全消息',
      kind: '通路',
      io: 'Secured-SPDM over DOE',
      formula: [
        'SPDM VENDOR_DEFINED_REQUEST / RESPONSE',
        'Application Data 用 AES-256-GCM 保护',
        '未安全传输的消息丢弃且不响应',
      ],
      meaning: 'TDISP 消息复用 DOE 的 SPDM 通道；安全性来自 Secured-SPDM 会话，而不是 TDISP 自己重新造一套加密。',
      value: 'DOE 01h / 02h',
    },
    'tdisp-data': {
      title: 'TVM 数据通路',
      kind: '通路',
      io: 'TVM 内存 ↔ TDI 资源',
      formula: [
        'T=1 的 TLP 只能走绑定到该 TDI 的 IDE 流',
        '内存读 / 写仅 RUN 状态允许',
        '绑定的 IDE 流 Insecure → TDI 转 ERROR',
      ],
      meaning: 'T 位解决“这是谁的 TLP”，IDE 解决“链路上是否机密完整”；两者绑定后，VMM 无法把别的流量混进 TVM 的信任域。',
      value: 'IDE + T 位',
    },
    'tdisp-lock': {
      title: 'LOCK_INTERFACE_REQUEST（83h）',
      kind: '消息',
      io: 'CONFIG_UNLOCKED → CONFIG_LOCKED',
      formula: [
        'FLAGS：NO_FW_UPDATE / LOCK_MSIX / BIND_P2P / ALL_REQUEST_REDIRECT',
        'Stream ID（default stream）+ MMIO_REPORTING_OFFSET',
        '设备生成 32 B nonce 并在响应中返回',
      ],
      meaning: '锁定是信任建立的起点：此后任何影响 TDI 安全的配置改动都会让 TDI 进入 ERROR。默认流必须是 TC0，密钥必须由同一 SPDM 会话编程。',
      value: '仅 CONFIG_UNLOCKED 合法',
    },
    'tdisp-start': {
      title: 'START_INTERFACE_REQUEST（86h）',
      kind: '消息',
      io: 'CONFIG_LOCKED → RUN',
      formula: [
        '携带 LOCK 阶段生成的 32 B nonce',
        '校验通过后进入 RUN 并销毁 nonce',
        '失败返回 INVALID_NONCE / INVALID_INTERFACE_STATE',
      ],
      meaning: 'nonce 校验保证 LOCK 与 START 发生在同一个 SPDM 安全会话内，防止中间人拼接两次合法交互。',
      value: '仅 CONFIG_LOCKED 合法',
    },
  },
};

/** 架构方块的输入/输出关系（用于结构化解析）。 */
const ARCH_IO = {
  eq: {
    ffe: 'x[n] → y[n]',
    channel: 'y[n] → r[n]',
    ctle: 'r[n] → z₁[n]',
    dfe: 'z₁[n] → z[n]',
    sampler: 'z[n] → 0 / 1',
  },
  cdr: {
    pd: 'φ_in → φ_e',
    lf: 'φ_e → φ_c',
    vco: 'φ_c → f_clk',
  },
  pll: {
    pd: 'φ_ref / φ_fb → φ_e',
    lf: 'φ_e → φ_c',
    vco: 'φ_c → f_vco',
    div: 'f_vco → f_fb',
  },
  pm: {
    platform: 'Vcc / Vaux / REF CLK / PERST# → RP',
    rp: 'LTSSM ↔ 链路；Slot Control ↔ 槽位',
    'rp-ctrl': 'RP 控制器 ↔ RP PHY（并行）',
    rpphy: 'RP 控制器 ↔ 差分对',
    epphy: 'EP 控制器 ↔ 差分对',
    slot: 'RP PHY ↔ 金手指 ↔ EP PHY',
    refclk: '平台 → 连接器 → EP PHY',
    clkreq: 'EP → 连接器 → 平台',
    clkgate: 'CLKREQ# + Idle → REF CLK EN',
    ep: 'PMCSR → D 状态 → 链路请求',
    pwr: '平台 → RP：电源 / 时钟 / 复位',
    link: 'RP ↔ EP：L0 / L1 / L2',
    sideband: 'EP → RP：CLKREQ# / Beacon / WAKE# / PM_PME',
    dmap: 'D 状态 → L 状态',
    lwake: 'L 状态 → 唤醒源',
    dstate: 'PMCSR.PowerState → D0…D3cold',
    lstate: 'LTSSM / ASPM → L0…L3',
    wake: 'CLKREQ# / Beacon / WAKE# / PME → 平台',
  },
  ras: {
    detect: '线路 / TLP → 错误指示',
    severity: '错误类型 → Correctable / Non-Fatal / Fatal',
    report: '错误状态 → ERR_* Message → RC',
    contain: '下游端口 → 阻塞链路',
    recover: '软件 / 平台 → 复位或换卡',
  },
};

/** 取某个架构方块/信号的说明；s 为 PhyModel.snapshot()，sim 为 Sim 实例（PM 模型使用）。 */
export function archInfo(model, key, s, sim) {
  const info = ARCH_INFO[model]?.[key];
  if (!info) return null;
  return {
    title: info.title,
    kind: info.kind || '环节',
    io: info.io || ARCH_IO[model]?.[key] || '',
    figure: info.figure || '',
    formula: info.formula,
    meaning: info.meaning,
    value: typeof info.value === 'function' ? info.value(s, sim) : (info.value || ''),
  };
}
