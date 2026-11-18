/**
 * 眼图 SVG（示意）：眼高/眼宽随 COM 与 CDR 锁定状态变化。
 *
 * NRZ（Gen1–5）：单个眼。
 * PAM4（Gen6 64 GT/s）：4 电平信号，上 / 中 / 下三个眼，单眼高度约为 NRZ 等效摆幅的 1/3。
 * 大尺寸（弹窗）会额外标注眼高/眼宽尺寸线、电压/时间轴、电平与眼模位置。
 */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** 眼口轮廓：三次贝塞尔在控制点取 1.34×半高时正好经过 ±openH，与轨迹包络对齐。 */
function lensPath(cx, cy, openW, openH) {
  const h = openH * 1.34;
  return [
    `M ${cx - openW} ${cy}`,
    `C ${cx - openW * 0.45} ${cy - h}, ${cx + openW * 0.45} ${cy - h}, ${cx + openW} ${cy}`,
    `C ${cx + openW * 0.45} ${cy + h}, ${cx - openW * 0.45} ${cy + h}, ${cx - openW} ${cy}`,
    'Z',
  ].join(' ');
}

/** 可复现的伪随机数：同一组参数渲染结果稳定，避免每帧重绘时噪点跳动。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller：标准正态分布，用于高斯白噪声。 */
function gaussOf(rnd) {
  const u = Math.max(1e-6, rnd());
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 持久化叠加轨迹：电压方向叠加高斯白噪声（AWGN），时间方向叠加随机抖动，
 * 轨迹够密时呈现真实示波器 / 协议分析仪眼图的“雾状”包络。
 * 眼开度越差、噪声滑块越大，σ 越大，眼口越糊。
 */
function tracesFor(cx, cy, openW, openH, wFactor, hFactor, color, noise, seed, count) {
  const rnd = mulberry32(seed);
  const sigV = openH * (0.035 + 0.12 * (1 - hFactor) + 0.55 * noise);
  const sigT = openW * (0.006 + 0.06 * (1 - wFactor) + 0.16 * noise);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const dir = rnd() < 0.5 ? -1 : 1;
    const amp = 0.84 + rnd() * 0.2; // 残余 ISI 引起的幅度抖动
    const jx = gaussOf(rnd) * sigT; // 整体相位抖动（RJ + DJ）
    const dy = gaussOf(rnd) * sigV * 0.5; // 低频偏置
    const pts = [];
    const N = 12;
    for (let k = 0; k <= N; k += 1) {
      const t = k / N;
      const shape = Math.sin(Math.PI * t) ** 2;
      const x = cx - openW + 2 * openW * t + jx;
      const y = cy - dir * openH * amp * shape + dy + gaussOf(rnd) * sigV * 0.6;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    const opacity = (0.1 + rnd() * 0.1).toFixed(2);
    out.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${color}"
      stroke-width="0.9" opacity="${opacity}" stroke-linejoin="round"/>`);
  }
  return out.join('');
}

/** 电平轨线：真实眼图中每一级电平上都叠着密集的水平轨迹，三眼借此连成一体。 */
function railsFor(m, plotW, levels, color, noise, seed, count = 7) {
  const rnd = mulberry32(seed);
  const sig = 1.0 + noise * 5;
  let out = '';
  levels.forEach((y) => {
    for (let i = 0; i < count; i += 1) {
      const dy = gaussOf(rnd) * sig;
      out += `<line x1="${m.left + 1}" y1="${(y + dy).toFixed(1)}"
        x2="${m.left + plotW - 1}" y2="${(y + dy).toFixed(1)}"
        stroke="${color}" stroke-width="0.9" opacity="${(0.07 + rnd() * 0.07).toFixed(2)}"/>`;
    }
  });
  return out;
}

function maskFor(cx, cy, maskW, maskH) {
  const pts = `${cx - maskW},${cy} ${cx - maskW / 2},${cy - maskH} ${cx + maskW / 2},${cy - maskH} ${cx + maskW},${cy} ${cx + maskW / 2},${cy + maskH} ${cx - maskW / 2},${cy + maskH}`;
  return `<g class="eye-mask" data-eye="mask" role="button" tabindex="0" aria-label="眼模（禁区）">
    <polygon points="${pts}" fill="transparent" stroke="transparent" stroke-width="10" pointer-events="all"/>
    <polygon points="${pts}" fill="none" stroke="#f43f5e" stroke-width="1" stroke-dasharray="2 2" opacity="0.8"/>
  </g>`;
}

function gridFor(m, plotW, plotH) {
  return [
    [0.25, 0], [0.5, 0], [0.75, 0],
  ].map(([fx]) => `<line x1="${m.left + plotW * fx}" y1="${m.top}" x2="${m.left + plotW * fx}" y2="${m.top + plotH}" stroke="#16243a"/>`).join('')
    + [0.33, 0.66].map((fy) => `<line x1="${m.left}" y1="${m.top + plotH * fy}" x2="${m.left + plotW}" y2="${m.top + plotH * fy}" stroke="#16243a"/>`).join('');
}

/* ---------- 示波器效果（仅大图 rich 模式） ---------- */

let eyeSeq = 0;

function scopeDefs(uid) {
  return `<filter id="${uid}Glow" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur stdDeviation="1.1" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>`;
}

function minorGrid(m, plotW, plotH) {
  let s = '';
  for (let x = m.left + 20; x < m.left + plotW; x += 20) {
    s += `<line x1="${x}" y1="${m.top}" x2="${x}" y2="${m.top + plotH}" stroke="#0c1f2f" stroke-width="0.5"/>`;
  }
  for (let y = m.top + 15; y < m.top + plotH; y += 15) {
    s += `<line x1="${m.left}" y1="${y}" x2="${m.left + plotW}" y2="${y}" stroke="#0c1f2f" stroke-width="0.5"/>`;
  }
  return s;
}

function scopeSweep(m, plotW, plotH) {
  const x0 = (m.left + 1).toFixed(1);
  const x1 = (m.left + plotW - 1).toFixed(1);
  const anim = `<animate attributeName="x1" values="${x0};${x1};${x1}" dur="6s" repeatCount="indefinite"/>
      <animate attributeName="x2" values="${x0};${x1};${x1}" dur="6s" repeatCount="indefinite"/>`;
  return `<line x1="${x0}" y1="${m.top}" x2="${x0}" y2="${m.top + plotH}" stroke="#38bdf8" stroke-width="8" opacity="0.04">${anim}</line>
    <line x1="${x0}" y1="${m.top}" x2="${x0}" y2="${m.top + plotH}" stroke="#7dd3fc" stroke-width="1" opacity="0.2">${anim}</line>`;
}

function scopeTags(m, plotW) {
  return `<text class="scope-tag" x="${m.left + 6}" y="${m.top + 11}">CH1 · EYE</text>
    <text class="scope-tag" x="${m.left + plotW - 6}" y="${m.top + 11}" text-anchor="end">TRIG ↑ AUTO</text>`;
}

/* ---------- 标注元件 ---------- */

function vDim(x, y1, y2, label) {
  const mid = (y1 + y2) / 2;
  return `<g class="eye-dim">
    <line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/>
    <polygon points="${x},${y1} ${x - 3},${y1 + 6} ${x + 3},${y1 + 6}"/>
    <polygon points="${x},${y2} ${x - 3},${y2 - 6} ${x + 3},${y2 - 6}"/>
    <text x="${x + 6}" y="${mid + 3}">${label}</text>
  </g>`;
}

function hDim(x1, x2, y, label) {
  const mid = (x1 + x2) / 2;
  return `<g class="eye-dim">
    <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/>
    <polygon points="${x1},${y} ${x1 + 6},${y - 3} ${x1 + 6},${y + 3}"/>
    <polygon points="${x2},${y} ${x2 - 6},${y - 3} ${x2 - 6},${y + 3}"/>
    <text x="${mid}" y="${y - 5}" text-anchor="middle">${label}</text>
  </g>`;
}

/** 时间轴：0 / 0.5 / 1 UI；电压轴：±眼高/2。 */
function axes(m, plotW, plotH, cx, cy, openW, openH, eyeHeightMv) {
  const bottom = m.top + plotH;
  const halfMv = Math.round(eyeHeightMv / 2);
  const xTicks = [cx - openW, cx, cx + openW];
  const xLabels = ['0 UI', '0.5 UI', '1 UI'];
  return `<g class="eye-axis">
    <line x1="${m.left}" y1="${bottom}" x2="${m.left + plotW}" y2="${bottom}"/>
    <line x1="${m.left - 8}" y1="${m.top}" x2="${m.left - 8}" y2="${bottom}"/>
    ${xTicks.map((x, i) => `<line x1="${x}" y1="${bottom}" x2="${x}" y2="${bottom + 4}"/>
      <text x="${x}" y="${bottom + 14}" text-anchor="middle">${xLabels[i]}</text>`).join('')}
    <text x="${4}" y="${m.top + 8}">mV</text>
    <text x="${m.left - 12}" y="${cy + 3}" text-anchor="end">0</text>
    <text x="${m.left - 12}" y="${cy - openH + 3}" text-anchor="end">+${halfMv}</text>
    <text x="${m.left - 12}" y="${cy + openH + 3}" text-anchor="end">−${halfMv}</text>
  </g>`;
}

/* ---------- NRZ ---------- */

function nrzEyeSvg(metrics, opts) {
  const { width, height, rich, uid, noise = 0 } = opts;
  const m = rich
    ? { left: 44, right: 110, top: 14, bottom: 26 }
    : { left: 8, right: 8, top: 4, bottom: 14 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const cx = m.left + plotW / 2;
  const cy = m.top + plotH / 2;
  const hFactor = clamp(metrics.eyeHeightMv / 820, 0.04, 1);
  const wFactor = clamp(metrics.eyeWidthPs / Math.max(1, metrics.uiPs) / 0.85, 0.04, 1);
  const openH = plotH * 0.05 + plotH * 0.30 * hFactor;
  const openW = plotW * 0.14 + plotW * 0.34 * wFactor;
  const color = metrics.comPass ? '#38bdf8' : '#f87171';
  const maskW = plotW * 0.11;
  const maskH = plotH * 0.13;

  const annotations = rich ? `
    ${vDim(Math.min(cx + openW + 16, width - 96), cy - openH, cy + openH,
    `眼高 ${metrics.eyeHeightMv.toFixed(0)} mV`)}
    ${hDim(cx - openW * 0.8, cx + openW * 0.8, cy + openH + 18,
    `眼宽 ${metrics.eyeWidthPs.toFixed(0)} ps`)}
    <text class="eye-anno" x="${cx}" y="${cy - openH - 8}" text-anchor="middle">眼模 / 采样点</text>
    ${axes(m, plotW, plotH, cx, cy, openW, openH, metrics.eyeHeightMv)}
  ` : '';

  const drawing = `<path d="${lensPath(cx, cy, openW, openH)}" fill="rgba(56,189,248,0.10)" stroke="${color}" stroke-width="1.2"/>
    ${tracesFor(cx, cy, openW, openH, wFactor, hFactor, color, noise, 1234, rich ? 90 : 22)}`;

  return `<svg class="eye-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="${height}" rx="6" fill="#08111f"/>
    ${rich ? `${scopeDefs(uid)}${minorGrid(m, plotW, plotH)}` : ''}
    ${gridFor(m, plotW, plotH)}
    ${rich ? `<g filter="url(#${uid}Glow)">${drawing}</g>` : drawing}
    ${maskFor(cx, cy, maskW, maskH)}
    ${rich ? scopeSweep(m, plotW, plotH) : ''}
    ${annotations}
    ${rich ? scopeTags(m, plotW) : ''}
    <text x="8" y="${height - 7}" class="eye-label">UI ${metrics.uiPs.toFixed(0)} ps · COM ${metrics.comDb.toFixed(1)} dB</text>
    <text x="${width - 8}" y="${height - 7}" text-anchor="end" class="eye-label">${metrics.comPass ? 'PASS' : 'FAIL'}</text>
  </svg>`;
}

/* ---------- PAM4：4 电平 → 上、中、下三个眼 ---------- */

function pam4EyeSvg(metrics, opts) {
  const { width, height, rich, uid, noise = 0 } = opts;
  const m = rich
    ? { left: 46, right: 110, top: 18, bottom: 26 }
    : { left: 8, right: 8, top: 6, bottom: 14 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const cx = m.left + plotW / 2;
  const hFactor = clamp((metrics.eyeHeightPerEyeMv ?? metrics.eyeHeightMv / 3) / (820 / 3), 0.04, 1);
  const wFactor = clamp(metrics.eyeWidthPs / Math.max(1, metrics.uiPs) / 0.85, 0.04, 1);
  // 三眼紧贴：单眼半高接近电平间距的一半（间距 = plotH × 0.26），眼口之间由电平轨线连成一体
  const openH = plotH * 0.13 * (0.85 + 0.15 * hFactor);
  const openW = plotW * 0.15 + plotW * 0.34 * wFactor;
  const color = metrics.comPass ? '#38bdf8' : '#f87171';
  const maskW = plotW * 0.10;
  const maskH = Math.max(2, openH * 0.45);
  // 4 个电平：L3(+3) / L2(+1) / L1(-1) / L0(-3)，对应 Gray 码 10 / 11 / 01 / 00
  const yL3 = m.top + plotH * 0.10;
  const yL2 = m.top + plotH * 0.36;
  const yL1 = m.top + plotH * 0.64;
  const yL0 = m.top + plotH * 0.90;
  const yU = (yL3 + yL2) / 2;
  const yM = (yL2 + yL1) / 2;
  const yL = (yL1 + yL0) / 2;

  const levelDefs = [
    { y: yL3, name: 'L3', bits: '10' },
    { y: yL2, name: 'L2', bits: '11' },
    { y: yL1, name: 'L1', bits: '01' },
    { y: yL0, name: 'L0', bits: '00' },
  ];
  const levels = levelDefs.map(({ y }) => `<line class="eye-level" x1="${m.left}" y1="${y}" x2="${m.left + plotW}" y2="${y}" stroke-dasharray="2 4"/>`).join('');

  // 电平 / 编码 两列标签 + 虚线线头指到对应电平线
  const levelHeaders = rich ? `
    <text class="eye-axis-text" x="6" y="${yL3 - 12}">电平</text>
    <text class="eye-axis-text" x="26" y="${yL3 - 12}">编码</text>` : '';
  const levelLabels = rich ? levelDefs.map(({ y, name, bits }) => `
    <text class="eye-axis-text" x="6" y="${y + 3}">${name}</text>
    <text class="eye-axis-text" x="26" y="${y + 3}">${bits}</text>
    <line x1="${m.left - 8}" y1="${y}" x2="${m.left - 1}" y2="${y}" stroke="#94a3b8" stroke-dasharray="2 2" opacity="0.75"/>
    <polygon points="${m.left},${y} ${m.left - 4},${y - 2.5} ${m.left - 4},${y + 2.5}" fill="#94a3b8" opacity="0.85"/>`).join('') : '';

  const thresholds = rich ? [
    [(yL3 + yL2) / 2, 'T2'],
    [(yL2 + yL1) / 2, 'T1'],
    [(yL1 + yL0) / 2, 'T0'],
  ].map(([y, t]) => `<line x1="${m.left}" y1="${y}" x2="${m.left + plotW}" y2="${y}" stroke="#94a3b8" stroke-opacity="0.22" stroke-dasharray="4 5"/>
    <text class="eye-anno" x="${m.left + plotW - 4}" y="${y - 3}" text-anchor="end">${t}</text>`).join('') : '';

  const annotations = rich ? `
    ${hDim(cx - openW * 0.85, cx + openW * 0.85, yL3 - 12, `眼宽 ${metrics.eyeWidthPs.toFixed(0)} ps`)}
    ${vDim(width - 92, yU - openH, yU + openH, `上眼 ${(metrics.eyeHeightPerEyeMv ?? 0).toFixed(0)} mV`)}
    ${vDim(width - 92, yM - openH, yM + openH, `中眼 ${(metrics.eyeHeightPerEyeMv ?? 0).toFixed(0)} mV`)}
    ${vDim(width - 92, yL - openH, yL + openH, `下眼 ${(metrics.eyeHeightPerEyeMv ?? 0).toFixed(0)} mV`)}
    <text class="eye-anno" x="${cx}" y="${yL0 + 16}" text-anchor="middle">上眼 L3↔L2 · 10/11 ｜ 中眼 L2↔L1 · 11/01 ｜ 下眼 L1↔L0 · 01/00</text>
    ${levelHeaders}
    ${levelLabels}
  ` : '';

  const drawing = `${railsFor(m, plotW, [yL3, yL2, yL1, yL0], color, noise, 7711)}
    <path d="${lensPath(cx, yU, openW, openH)}" fill="rgba(56,189,248,0.10)" stroke="${color}" stroke-width="1.2"/>
    <path d="${lensPath(cx, yM, openW, openH)}" fill="rgba(56,189,248,0.10)" stroke="${color}" stroke-width="1.2"/>
    <path d="${lensPath(cx, yL, openW, openH)}" fill="rgba(56,189,248,0.10)" stroke="${color}" stroke-width="1.2"/>
    ${tracesFor(cx, yU, openW, openH, wFactor, hFactor, color, noise, 1234, rich ? 70 : 18)}
    ${tracesFor(cx, yM, openW, openH, wFactor, hFactor, color, noise, 2211, rich ? 70 : 18)}
    ${tracesFor(cx, yL, openW, openH, wFactor, hFactor, color, noise, 3188, rich ? 70 : 18)}`;

  return `<svg class="eye-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="${height}" rx="6" fill="#08111f"/>
    ${rich ? `${scopeDefs(uid)}${minorGrid(m, plotW, plotH)}` : ''}
    ${gridFor(m, plotW, plotH)}
    ${levels}
    ${thresholds}
    ${rich ? `<g filter="url(#${uid}Glow)">${drawing}</g>` : drawing}
    ${maskFor(cx, yU, maskW, maskH)}
    ${maskFor(cx, yM, maskW, maskH)}
    ${maskFor(cx, yL, maskW, maskH)}
    ${rich ? scopeSweep(m, plotW, plotH) : ''}
    ${annotations}
    ${rich ? scopeTags(m, plotW) : ''}
    <text x="8" y="${height - 7}" class="eye-label">PAM4 · 4 电平 · 3 eye · UI ${metrics.uiPs.toFixed(0)} ps · COM ${metrics.comDb.toFixed(1)} dB</text>
    <text x="${width - 8}" y="${height - 7}" text-anchor="end" class="eye-label">${metrics.comPass ? 'PASS' : 'FAIL'}</text>
  </svg>`;
}

export function eyeSvg(metrics, opts = {}) {
  const width = opts.width ?? 260;
  const height = opts.height ?? 90;
  const rich = opts.detail ?? width >= 420;
  eyeSeq += 1;
  const cfg = { width, height, rich, uid: `eye${eyeSeq}`, noise: opts.noise ?? 0 };
  return metrics.pam4 ? pam4EyeSvg(metrics, cfg) : nrzEyeSvg(metrics, cfg);
}

/**
 * PAM4 UI 级信号示意图（参考 PCIe 6.2 Figure 4-24）：
 * 4 个电压电平、Gray 2-bit 编码与对应 DC balance 值。
 */
export function pam4UiSvg() {
  const levels = [
    { y: 30, name: 'L3', amp: '+3', bits: '10', dc: '+1' },
    { y: 70, name: 'L2', amp: '+1', bits: '11', dc: '+1/3' },
    { y: 110, name: 'L1', amp: '−1', bits: '01', dc: '−1/3' },
    { y: 150, name: 'L0', amp: '−3', bits: '00', dc: '−1' },
  ];
  const seq = [1, 0, 2, 3];
  const x0 = 300;
  const uiW = 96;

  let d = `M${x0},${levels[seq[0]].y}`;
  seq.forEach((li, i) => {
    d += ` h${uiW}`;
    if (i < seq.length - 1) d += ` V${levels[seq[i + 1]].y}`;
  });

  const levelRows = levels.map((lv) => `<text class="eye-label" x="8" y="${lv.y + 3}">${lv.name}</text>
    <text class="eye-label" x="52" y="${lv.y + 3}">${lv.amp}</text>
    <text class="eye-label" x="96" y="${lv.y + 3}">${lv.bits}</text>
    <text class="eye-label" x="140" y="${lv.y + 3}">DC ${lv.dc}</text>`).join('');

  // 表格电平行 → 波形电平线：虚线线头指示
  const leads = levels.map(({ y }) => `<line x1="196" y1="${y}" x2="${x0 - 5}" y2="${y}" stroke="#94a3b8" stroke-dasharray="3 4" opacity="0.35"/>
    <polygon points="${x0},${y} ${x0 - 6},${y - 2.5} ${x0 - 6},${y + 2.5}" fill="#94a3b8" opacity="0.5"/>`).join('');

  const thresholds = [50, 90, 130].map((y, i) => `<line x1="${x0}" y1="${y}" x2="${x0 + uiW * 4}" y2="${y}"
      stroke="#94a3b8" stroke-dasharray="3 4" opacity="0.5"/>
    <text class="eye-label" x="${x0 + uiW * 4 + 6}" y="${y + 3}">T${2 - i}</text>`).join('');

  const boundaries = seq.map((_, i) => `<line x1="${x0 + uiW * i}" y1="18" x2="${x0 + uiW * i}" y2="170" stroke="#16243a"/>`).join('');

  const uiLabels = seq.map((li, i) => {
    const lv = levels[li];
    const cx = x0 + uiW * i + uiW / 2;
    return `<text class="eye-label" x="${cx}" y="182" text-anchor="middle">${lv.bits}</text>
      <text class="eye-label" x="${cx}" y="194" text-anchor="middle" opacity="0.75">DC ${lv.dc}</text>`;
  }).join('');

  return `<svg class="model-svg" viewBox="0 0 720 210" xmlns="http://www.w3.org/2000/svg">
    <text class="eye-axis-text" x="8" y="12">电平</text>
    <text class="eye-axis-text" x="52" y="12">幅度</text>
    <text class="eye-axis-text" x="96" y="12">编码</text>
    <text class="eye-axis-text" x="140" y="12">DC balance</text>
    <text class="eye-axis-text" x="${x0}" y="12">UI 级波形（4 个符号）</text>
    <text class="eye-axis-text" x="700" y="12" text-anchor="end">ΣDC = 0</text>
    <line x1="8" y1="16" x2="196" y2="16" stroke="#16243a"/>
    ${leads}
    ${levelRows}
    ${thresholds}
    ${boundaries}
    <path d="${d}" fill="none" stroke="#38bdf8" stroke-width="1.6"/>
    <line x1="${x0}" y1="170" x2="${x0 + uiW * 4}" y2="170" stroke="#2b4162"/>
    ${uiLabels}
    <text class="eye-label" x="8" y="205">Gray 编码：相邻电平仅 1 bit 不同；上眼 = L3↔L2（10/11），中眼 = L2↔L1（11/01），下眼 = L1↔L0（01/00）；T2/T1/T0 为判决阈值</text>
  </svg>`;
}
