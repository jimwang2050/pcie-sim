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
    <p class="hint">模型只覆盖 PCIe 基础 RAS（AER / DPC / 热插拔 / 复位）；CXL 的 RAS 能力与 DOE、RAS Capability 寄存器不在本模型范围内。</p>

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
