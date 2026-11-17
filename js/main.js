/**
 * UI 入口：控制条、渲染调度与事件跟随逻辑。
 *
 * 事件详情默认跟随“当前时刻最新事件”；
 * 选中某一行后只跟随该行最新事件；单击方框会锁定该事件，单步/运行后恢复跟随。
 */
import { Sim } from './core/sim.js';
import { findLtssmInfo } from './core/ltssm_info.js';
import { playbackTiming } from './core/playback.js';
import { buildLinkTraining } from './scenarios/link_training.js';
import { buildLtssmPm } from './scenarios/ltssm_pm.js';
import { buildPhyLink } from './scenarios/phy_link.js';
import { buildLoopbackBert } from './scenarios/loopback_bert.js';
import { buildMemRead } from './scenarios/mem_read.js';
import { buildMemWrite } from './scenarios/mem_write.js';
import { buildMsiInt } from './scenarios/msi_int.js';
import { buildAerError } from './scenarios/aer_error.js';
import { buildDpcRpio } from './scenarios/dpc_rpio.js';
import { buildAts } from './scenarios/ats.js';
import { buildPmDp } from './scenarios/pm_dp.js';
import { buildFlitGen6 } from './scenarios/flit_gen6.js';
import { buildEnumeration } from './scenarios/enumeration.js';
import { formatBits, BERT_PATTERNS, BERT_PATTERN_ORDER } from './core/bert.js';
import { loopbackLabel } from './core/loopback.js';
import { Timeline } from './ui/timeline.js';
import { FlowView } from './ui/flowview.js';
import { renderTopology } from './ui/topology.js';
import {
  renderLinkInfo, renderLTSSM, renderCounters, renderConfig, renderPhy,
  renderIrq, renderPm, renderFlit, renderLog, renderInspector, renderAts,
} from './ui/panels.js';
import { eyeSvg, pam4UiSvg } from './ui/eye.js';
import { GEN_RATE } from './core/packet.js';
import {
  eqModel, cdrModel, pllModel, genModel, pmModel, rasModel, orderingModel, archInfo,
  L_STATE_ROWS, D_DEF, P_DEF, PM_LAYERS,
} from './ui/models.js';
import { renderCfgLayout, renderCfgFieldDetail } from './ui/cfg_layout.js';
import { PMCSR_BITS } from './core/pm.js';

const $ = (id) => document.getElementById(id);

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const sim = new Sim();
const timeline = new Timeline($('timeline'), {
  onSelect: selectEvent,
  onSelectRow: selectRow,
});
const flowView = new FlowView($('flow'), { onSelect: selectEvent });

const elScenario = $('scenario');
const elGen = $('gen');
const elWidth = $('width');
const elMode = $('mode');
const elPattern = $('pattern');
const elLpbk = $('lpbk');
const elSpeed = $('speed');
const btnReset = $('reset');
const btnBack = $('back');
const btnStep = $('step');
const btnRun = $('run');
const modal = $('eventModal');
const modalBody = $('modalBody');
const elTheme = $('themeToggle');

// 深色 / 浅色两套主题：记在 localStorage，刷新后保持
const THEME_KEY = 'pcie-sim-theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  elTheme.textContent = theme === 'light' ? '深色' : '浅色';
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (e) {
    // 隐私模式下无法持久化，忽略
  }
}

elTheme.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

(() => {
  let saved = 'dark';
  try {
    saved = localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch (e) {
    saved = 'dark';
  }
  applyTheme(saved);
})();

let scenarioKey = 'link_training';
let modalMode = 'event';
let modelKind = 'eq';
let cfgType = 'type0';
let cdrPreview = null;
let eqPhasePreview = null;
let pmScnPreview = 'l1';
let modelPhaseKey = '';
let selectedRow = 'STATE';
let pinnedId = null;
let running = false;
let timer = null;
let speed = 0.5;
let phyCollapsed = true;
let notesOpen = false;
let flowMode = false;

function currentConfig() {
  return {
    gen: Number(elGen.value),
    width: Number(elWidth.value),
    mode: elMode.value,
  };
}

const SUBTITLES = {
  link_training: 'M1 · 上电复位 → 链路训练 → L0',
  ltssm_pm: 'LTSSM 电源管理 · L0s / L1.0–1.2 / L2 唤醒 + 热插拔',
  phy_link: 'PHY 电气 · REF CLK / PLL / CDR / EQ / COM',
  loopback_bert: 'Loopback / BERT · Internal 或 External（独立配置）',
  enumeration: 'M2 · 设备枚举（配置空间 / BAR）',
  mem_read: 'M3 · 内存读（MRd → CplD）',
  mem_write: 'M3 · 内存写（MWr Posted）',
  msi_int: 'M4 · MSI / MSI-X 中断',
  aer_error: 'M4 · AER 错误上报 + Hot Reset',
  dpc_rpio: 'DPC · 下游端口隔离 + RP PIO',
  ats: 'ATS · 地址翻译 / ATC 失效 / PRI 缺页',
  pm_dp: 'PM · D 状态 / P 状态',
  flit_gen6: 'M5 · Gen6 Flit 打包 / FEC / 重传',
};

const PANEL_VIS = {
  link_training: { phy: true, config: false, counters: true },
  ltssm_pm: { phy: true, config: false, counters: false },
  phy_link: { phy: true, config: false, counters: false },
  loopback_bert: { phy: true, config: false, counters: false },
  flit_gen6: { phy: false, config: false, counters: false },
  enumeration: { phy: false, config: true, counters: false },
  mem_read: { phy: false, config: true, counters: true },
  mem_write: { phy: false, config: true, counters: true },
  msi_int: { phy: false, config: false, counters: false },
  aer_error: { phy: false, config: false, counters: false },
  dpc_rpio: { phy: false, config: false, counters: false },
  ats: { phy: false, config: false, counters: false },
  pm_dp: { phy: false, config: false, counters: false },
};

const SCENARIO_SUMMARY = {
  link_training: '复位 → Detect → Polling → Configuration → L0；Gen6 使用 Flit。',
  ltssm_pm: 'L0s 用 FTS 退出；L1 用 CLKREQ# 唤醒；L2 用 Beacon 唤醒；热插拔经 PRSNT# → 上电 → 训练 → DLLSC。',
  phy_link: 'REF CLK / PLL → CDR → Equalization → COM / 眼图。',
  loopback_bert: 'Internal / External 是两套独立环回配置；各自完成 BERT 多图案与误码注入。',
  flit_gen6: '256B Flit 打包、FEC/CRC 校验与 Flit 级重传。',
  enumeration: 'CfgRd0 / CfgWr0、BAR 探测/分配与 Memory Enable。',
  mem_read: 'MRd → 2×CplD，Tag 匹配与 Cpl 信用。',
  mem_write: 'Posted MWr、P 信用与写后读回。',
  msi_int: 'MSI / MSI-X 消息、向量与 mask。',
  aer_error: 'ERR_COR / ERR_NONFATAL / ERR_FATAL 与 Hot Reset。',
  dpc_rpio: 'DPC 触发 → 链路隔离 → Egress Control / RP PIO → 软件恢复。',
  ats: 'Translation Request → ATC 命中 → Invalid Request → Invalidate → Page Request / PRG Response。',
  pm_dp: 'D0–D3cold（软件可见）、P0–P2（PHY PIPE PowerDown 编码）、PMCSR 与 PME 唤醒。',
};

function buildScenario(cfg) {
  if (scenarioKey === 'ltssm_pm') {
    return buildLtssmPm(sim, { gen: cfg.gen, width: cfg.width });
  }
  if (scenarioKey === 'phy_link') {
    return buildPhyLink(sim, { gen: cfg.gen, width: cfg.width });
  }
  if (scenarioKey === 'loopback_bert') {
    return buildLoopbackBert(sim, {
      gen: cfg.gen, width: cfg.width, pattern: elPattern.value, mode: elLpbk.value,
    });
  }
  if (scenarioKey === 'mem_read') {
    return buildMemRead(sim, { gen: cfg.gen, width: cfg.width });
  }
  if (scenarioKey === 'mem_write') {
    return buildMemWrite(sim, { gen: cfg.gen, width: cfg.width });
  }
  if (scenarioKey === 'msi_int') {
    return buildMsiInt(sim, { gen: cfg.gen, width: cfg.width });
  }
  if (scenarioKey === 'aer_error') {
    return buildAerError(sim, { gen: cfg.gen, width: cfg.width });
  }
  if (scenarioKey === 'dpc_rpio') {
    return buildDpcRpio(sim, { gen: cfg.gen, width: cfg.width });
  }
  if (scenarioKey === 'ats') {
    return buildAts(sim, { gen: cfg.gen, width: cfg.width });
  }
  if (scenarioKey === 'pm_dp') {
    return buildPmDp(sim, { gen: cfg.gen, width: cfg.width });
  }
  if (scenarioKey === 'flit_gen6') {
    return buildFlitGen6(sim, { width: cfg.width });
  }
  if (scenarioKey === 'enumeration') {
    return buildEnumeration(sim, { gen: cfg.gen, width: cfg.width });
  }
  return buildLinkTraining(sim, cfg);
}

/** 当前应展示的事件：锁定事件优先，否则取当前时刻目标行的最新事件。 */
function detailEvent() {
  if (pinnedId !== null) {
    const ev = sim.events.find((e) => e.id === pinnedId);
    if (ev) return ev;
  }

  const clock = sim.clock + 1e-9;

  if (selectedRow) {
    for (let i = sim.events.length - 1; i >= 0; i -= 1) {
      const ev = sim.events[i];
      if (ev.t_ns > clock) continue;
      if (ev.row === selectedRow) return ev;
    }
    return null;
  }

  // 默认取当前时刻最新事件；同一时刻有多条时优先 LTSSM 状态事件。
  let latest = null;
  for (let i = sim.events.length - 1; i >= 0; i -= 1) {
    const ev = sim.events[i];
    if (ev.t_ns > clock) continue;
    if (!latest) {
      latest = ev;
    } else if (ev.t_ns < latest.t_ns - 1e-9) {
      break;
    }
    if (ev.row === 'STATE') return ev;
  }
  return latest;
}

function updateTargetChip() {
  const chip = $('detailTarget');
  if (pinnedId !== null) {
    chip.textContent = `已锁定 #${pinnedId}`;
    chip.classList.add('active');
  } else if (selectedRow) {
    const row = (sim.rows || []).find((r) => r.key === selectedRow);
    chip.textContent = `跟随 · ${row ? row.label : selectedRow}`;
    chip.classList.add('active');
  } else {
    chip.textContent = '跟随 · 全部';
    chip.classList.remove('active');
  }
}

function reset() {
  stop();
  closeModal(false);
  pinnedId = null;
  modalMode = 'event';
  if (scenarioKey === 'flit_gen6') elGen.value = '6';
  const cfg = currentConfig();
  sim.reset(cfg);
  const info = buildScenario(cfg);
  selectedRow = info.defaultRow !== undefined ? info.defaultRow : 'STATE';
  elMode.disabled = scenarioKey !== 'link_training';
  elGen.disabled = scenarioKey === 'flit_gen6';
  $('patternLabel').hidden = scenarioKey !== 'loopback_bert';
  $('lpbkLabel').hidden = scenarioKey !== 'loopback_bert';
  // Internal 环回固定使用短序列 PRBS7，图案选择只对 External 生效
  elPattern.disabled = scenarioKey === 'loopback_bert' && elLpbk.value === 'internal';
  $('subtitle').textContent = SUBTITLES[scenarioKey] || SUBTITLES.link_training;
  document.title = `PCIe 模拟器 · ${SUBTITLES[scenarioKey] || SUBTITLES.link_training}`;
  // 先执行首个事件，让时间轴与自动浮窗在就绪时就有内容。
  sim.stepOnce();
  timeline.setSim(sim);
  flowView.setSim(sim, scenarioKey);
  renderAll(true);
  $('status').dataset.note = `已生成 ${info.totalSteps} 个仿真步`;
}

function openModal(id) {
  modalMode = 'event';
  $('modalTitle').textContent = '事件详情';
  if (id === null) {
    modalBody.innerHTML = '<p class="empty">当前时刻还没有事件。</p>';
  } else {
    renderInspector(modalBody, sim, id);
  }
  modal.hidden = false;
}

function openCompare() {
  modalMode = 'compare';
  $('modalTitle').textContent = 'Flit / Non-Flit 模式差异';
  modalBody.innerHTML = `<table class="compare">
    <thead><tr><th>维度</th><th>Non-Flit（Gen1–5）</th><th>Flit（Gen6）</th></tr></thead>
    <tbody>
      <tr><td>适用速率</td><td>2.5 – 32 GT/s</td><td>64 GT/s 强制；低速率双方支持时可选</td></tr>
      <tr><td>编码</td><td>8b/10b 或 128b/130b</td><td>1b/1b（PAM4）+ FEC</td></tr>
      <tr><td>数据单元</td><td>TLP / DLLP 连续数据流</td><td>固定 256B Flit</td></tr>
      <tr><td>成帧</td><td>STP / END 帧定界符</td><td>无 STP/END，按 Flit 边界解析</td></tr>
      <tr><td>链路保护</td><td>每 TLP：LCRC + 12bit 序列号</td><td>每 Flit：DLP 6B + 双份 CRC-32 + FEC 3 组</td></tr>
      <tr><td>错误处理</td><td>LCRC 错 → 重传整个 TLP</td><td>FEC 纠正 ≤2bit；不可纠 → CRC 失败 → 重传整个 Flit</td></tr>
      <tr><td>重传单位</td><td>以 TLP 为单位的 Ack/Nak</td><td>以 Flit 为单位的 Ack/Nak 与重放</td></tr>
      <tr><td>对齐与有序集</td><td>COM / SKP / TS1 / TS2</td><td>SDS / EIEOS / SKP + Flit 对齐</td></tr>
      <tr><td>编码开销</td><td>8b/10b ≈20%；128b/130b ≈1.5%</td><td>1b/1b 无编码开销；Flit 保护 ≈7.8%</td></tr>
    </tbody>
  </table>
  <p class="hint">Flit 将多个 TLP/DLLP 打包进固定 256B 单元，链路层保护与重传粒度随之变为 Flit。</p>`;
  modal.hidden = false;
}

function openStateInfo(key) {
  const info = findLtssmInfo(key);
  if (!info) return;
  modalMode = 'state';
  $('modalTitle').textContent = info.cn.includes(info.key) ? info.cn : `${info.cn} · ${info.key}`;
  const list = (arr) => `<ul>${arr.map((t) => `<li>${escHtml(t)}</li>`).join('')}</ul>`;
  modalBody.innerHTML = `<div class="state-info">
    <p class="state-def">${escHtml(info.definition)}</p>
    <div class="state-grid">
      <section><h4>进入条件</h4>${list(info.entry)}</section>
      <section><h4>退出条件</h4>${list(info.exit)}</section>
    </div>
    <section><h4>物理意义</h4><p>${escHtml(info.physical)}</p></section>
    ${info.substates && info.substates.length
    ? `<section><h4>主要子状态</h4><div class="state-chips">${info.substates.map((s) => `<span>${escHtml(s)}</span>`).join('')}</div></section>`
    : ''}
    ${info.wake && info.wake.length
    ? `<section><h4>唤醒机制</h4>${list(info.wake)}</section>`
    : ''}
  </div>`;
  modal.hidden = false;
}

function renderConfigLayout() {
  renderCfgLayout($('cfgLayout'), sim.config, cfgType);
  const detailEl = $('cfgFieldDetail');
  detailEl.innerHTML = '点击任意字段查看位域定义。';
  modalBody.querySelectorAll('.cfg-field').forEach((btn) => {
    btn.addEventListener('click', () => {
      modalBody.querySelectorAll('.cfg-field.selected').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      renderCfgFieldDetail(detailEl, sim.config,
        Number(btn.dataset.off), Number(btn.dataset.lo), Number(btn.dataset.hi), cfgType);
    });
  });
  const note = $('cfgNote');
  if (note) {
    note.textContent = cfgType === 'type1'
      ? '当前设备是 Type 0 端点；以上为 Type 1（PCI-to-PCI Bridge / Root Port）参考布局，取值示例 / DWC 复位值。'
      : '每行一个 32-bit DWORD；字段宽度与位域宽度成比例。点击字段查看 Bits、访问属性与说明。';
  }
}

function openConfigDump() {
  modalMode = 'config';
  $('modalTitle').textContent = '配置空间 Header Layout（Type 0 / Type 1）';
  modalBody.innerHTML = `<div class="cfg-tabs">
      <button type="button" class="cfg-tab${cfgType === 'type0' ? ' active' : ''}" data-cfg-type="type0">Type 0 · 端点</button>
      <button type="button" class="cfg-tab${cfgType === 'type1' ? ' active' : ''}" data-cfg-type="type1">Type 1 · 桥 / Root Port</button>
    </div>
    <div id="cfgLayout"></div>
    <div id="cfgFieldDetail" class="cfg-detail">点击任意字段查看位域定义。</div>
    <p class="hint" id="cfgNote"></p>`;
  renderConfigLayout();
  modalBody.querySelectorAll('[data-cfg-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (cfgType === btn.dataset.cfgType) return;
      cfgType = btn.dataset.cfgType;
      modalBody.querySelectorAll('[data-cfg-type]').forEach((b) => b.classList.toggle('active', b === btn));
      modalBody.scrollTop = 0;
      renderConfigLayout();
    });
  });
  modal.hidden = false;
}

function modelHtml(kind) {
  const s = sim.phy.snapshot();
  if (kind === 'cdr') return cdrModel(s, cdrPreview);
  if (kind === 'pll') return pllModel(s);
  if (kind === 'gen') return genModel(s);
  if (kind === 'pm') {
    return pmModel({
      pm: sim.pm.snapshot(),
      link: sim.link.snapshot(),
      hotplug: sim.hotplug.snapshot(),
      phy: s,
    }, pmScnPreview);
  }
  if (kind === 'ras') {
    return rasModel({ aer: sim.aer.snapshot(), dpc: sim.dpc.snapshot() });
  }
  if (kind === 'ordering') {
    return orderingModel({ sim });
  }
  return eqModel(s, eqPhasePreview);
}

function bindModelInteractions() {
  modalBody.querySelectorAll('[data-cdr-stage]').forEach((el) => {
    el.addEventListener('click', () => {
      cdrPreview = el.dataset.cdrStage;
      renderModelBody();
    });
  });
  const reset = modalBody.querySelector('[data-cdr-reset]');
  if (reset) {
    reset.addEventListener('click', () => {
      cdrPreview = null;
      renderModelBody();
    });
  }
  // EQ 阶段：点击预览，运行/单步时自动跟随仿真阶段
  modalBody.querySelectorAll('[data-eq-phase]').forEach((el) => {
    el.addEventListener('click', () => {
      eqPhasePreview = Number(el.dataset.eqPhase);
      renderModelBody();
    });
  });
  const eqReset = modalBody.querySelector('[data-eq-reset]');
  if (eqReset) {
    eqReset.addEventListener('click', () => {
      eqPhasePreview = null;
      renderModelBody();
    });
  }
  // PM 交互场景：L1 / L2 / 热插拔 切换
  modalBody.querySelectorAll('[data-pm-scn]').forEach((el) => {
    el.addEventListener('click', () => {
      pmScnPreview = el.dataset.pmScn;
      renderModelBody();
    });
  });
  // 架构方块：点击弹出公式与物理含义
  modalBody.querySelectorAll('[data-arch]').forEach((g) => {
    const activate = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      showArchPop(g);
    };
    g.addEventListener('click', activate);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') activate(e);
    });
  });
}

let archPop = null;

function closeArchPop() {
  if (archPop) {
    archPop.remove();
    archPop = null;
  }
}

function showInfoPop(anchorEl, innerHTML) {
  closeArchPop();
  const pop = document.createElement('div');
  pop.className = 'arch-pop';
  pop.innerHTML = innerHTML;

  const margin = 12;
  const gap = 12;
  const r = anchorEl.getBoundingClientRect();
  // 优先停靠在弹窗卡片外侧，避免浮窗压住架构图；空间不足时再退回锚点上下方
  const cardEl = document.querySelector('.modal:not([hidden]) .modal-card');
  const cr = cardEl ? cardEl.getBoundingClientRect() : null;
  const roomRight = cr ? window.innerWidth - cr.right - gap - margin : 0;
  const roomLeft = cr ? cr.left - gap - margin : 0;
  // 带示意图的浮窗需要更宽的停靠位，否则示意图会被压得过小
  const hasFigure = !!pop.querySelector('.arch-pop-figure');
  const need = hasFigure ? 560 : 280;
  const maxW = hasFigure ? 620 : 300;
  const dockRight = roomRight >= need && roomRight >= roomLeft;
  const dockLeft = !dockRight && roomLeft >= need;
  // 图内机制：卡片外侧放不下时改为贴在架构图下方，避免遮挡图本身
  const inSvg = anchorEl.closest('svg');

  if (!dockRight && !dockLeft && inSvg) {
    pop.classList.add('arch-pop-inline');
    inSvg.insertAdjacentElement('afterend', pop);
    pop.querySelector('[data-pop-close]')?.addEventListener('click', closeArchPop);
    archPop = pop;
    pop.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }

  document.body.appendChild(pop);

  if (dockRight || dockLeft) {
    const room = dockRight ? roomRight : roomLeft;
    pop.style.width = `${Math.min(maxW, room)}px`;
    const h = pop.offsetHeight;
    const top = Math.min(Math.max(margin, r.top + r.height / 2 - h / 2), window.innerHeight - h - margin);
    pop.style.left = `${dockRight ? cr.right + gap : cr.left - gap - pop.offsetWidth}px`;
    pop.style.top = `${Math.max(margin, top)}px`;
  } else {
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const left = Math.min(Math.max(margin, r.left + r.width / 2 - w / 2), window.innerWidth - w - margin);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - margin) {
      const spaceAbove = r.top - margin - 8;
      const spaceBelow = window.innerHeight - r.bottom - margin - 8;
      if (spaceAbove >= spaceBelow && spaceAbove > 220) {
        pop.style.maxHeight = `${Math.min(h, spaceAbove)}px`;
        top = Math.max(margin, r.top - 8 - pop.offsetHeight);
      } else if (spaceBelow > 220) {
        pop.style.maxHeight = `${Math.min(h, spaceBelow)}px`;
      } else {
        top = Math.max(margin, r.top - h - 8);
      }
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
  pop.querySelector('[data-pop-close]')?.addEventListener('click', closeArchPop);
  archPop = pop;
}

function showArchPop(node) {
  const info = archInfo(modelKind, node.dataset.arch, sim.phy.snapshot(), sim);
  if (!info) return;
  showInfoPop(node, `<div class="arch-pop-head">
      <b>${escHtml(info.title)}</b>
      <span class="arch-pop-kind">${escHtml(info.kind)}</span>
      <button class="icon-btn" type="button" data-pop-close aria-label="关闭">×</button>
    </div>
    ${info.io ? `<div class="arch-pop-io"><span>路径</span>${escHtml(info.io)}</div>` : ''}
    ${info.figure ? `<div class="arch-pop-figure">${info.figure}</div>` : ''}
    <div class="arch-pop-sec">
      <span class="arch-pop-label">数学表达</span>
      <div class="arch-pop-formula">${info.formula.map((f) => `<div>${escHtml(f)}</div>`).join('')}</div>
    </div>
    <div class="arch-pop-sec">
      <span class="arch-pop-label">物理含义</span>
      <p class="arch-pop-mean">${escHtml(info.meaning)}</p>
    </div>
    ${info.value
    ? `<div class="arch-pop-sec"><span class="arch-pop-label">当前工作点</span><div class="arch-pop-val">${escHtml(info.value)}</div></div>`
    : ''}`);
}

function renderModelBody() {
  closeArchPop();
  const top = modalBody.scrollTop;
  modalBody.innerHTML = modelHtml(modelKind);
  bindModelInteractions();
  modalBody.scrollTop = top;
}

function openModel(kind, title) {
  modalMode = 'model';
  modelKind = kind;
  modelPhaseKey = '';
  if (kind === 'cdr') cdrPreview = null;
  if (kind === 'eq') eqPhasePreview = null;
  if (kind === 'pm') pmScnPreview = 'l1';
  $('modalTitle').textContent = title;
  renderModelBody();
  // 打开模型时回到顶部：首先看到「架构」作为首页
  modalBody.scrollTop = 0;
  modal.hidden = false;
}

function openEqModel() {
  openModel('eq', '典型模型 · EQ 均衡');
}

function openCdrModel() {
  openModel('cdr', '典型模型 · CDR 时钟恢复');
}

function openPllModel() {
  openModel('pll', '典型模型 · REF CLK / PLL');
}

function openGenModel() {
  openModel('gen', '典型模型 · Gen 差异对照');
}

function openPmModel() {
  openModel('pm', '典型模型 · PM 电源管理 / 唤醒');
}

function openRasModel() {
  openModel('ras', '典型模型 · RAS 可靠性 / 可维护性');
}

function openOrderingModel() {
  openModel('ordering', '典型模型 · PCIe 排序规则（Ordering）');
}

const SCENARIO_MECH = {
  ltssm_pm: [['clkreq', 'CLKREQ# 唤醒'], ['beacon', 'Beacon 唤醒'], ['wake', 'WAKE# 边带'], ['pme', 'PME 上报'], ['hotplug', '热插拔机制']],
  dpc_rpio: [['dpc', 'DPC 机制'], ['rppio', 'RP PIO 机制'], ['egress', 'Egress Control']],
  ats: [['ats', 'ATS 机制'], ['pri', 'PRI 机制'], ['atc', 'ATC 与 Invalidate']],
  loopback_bert: [['lpbkInt', 'Internal 环回'], ['lpbkExt', 'External 环回'], ['pattern', 'BERT 图案']],
};

const MECH_INFO = {
  clkreq: {
    title: 'CLKREQ# · L1 / L1 子状态唤醒（边带）',
    meaning: 'CLKREQ# 是开漏、低有效的边带信号，由设备驱动，用来请求参考时钟。L1.1 / L1.2 下 REF CLK 已被关闭，设备要退出低功耗必须先拉低 CLKREQ# 把时钟要回来。它只适用于 L1 及 L1 子状态，不能唤醒 L2。',
    points: [
      '进入：EP 释放 CLKREQ#（高）→ 平台关闭 REF CLK（L1.1）；L1.2 进一步对 PHY 电源门控',
      '唤醒第 1 步：EP 拉低 CLKREQ#（开漏，需要上拉电阻；平台侧常驻供电）',
      '唤醒第 2 步：平台 / RC 恢复 REF CLK，等待时钟稳定（SSC、ppm 收敛）',
      '唤醒第 3 步：RC PLL 重新锁定、CDR 就绪',
      '唤醒第 4 步：链路进入 Recovery.RcvrLock → RcvrCfg → Idle → L0（保留链路配置，无需重新枚举）',
      '退出延迟：L1.0 最短；L1.1 增加时钟恢复；L1.2 最长（电源门控 + 时钟恢复）',
    ],
  },
  beacon: {
    title: 'Beacon · L2 唤醒（带内信标）',
    meaning: 'L2 下主电源关闭、仅 Vaux 供电，REF CLK 与链路时钟都不存在，CLKREQ# 已无法起作用。设备改为在差分对上发送 Beacon 脉冲串，由 RC 的 Beacon 检测电路识别后请求平台恢复主电源。',
    points: [
      '物理形态：差分对上的周期性低频脉冲串（信标），不是正常编码数据，无需链路时钟即可被检测',
      '设备仅靠 Vaux 供电产生 Beacon，功耗极低',
      'RC 的 Beacon 检测电路常驻 Vaux 供电，识别后向平台发出唤醒请求',
      '平台恢复主电源与 REF CLK，释放 Fundamental Reset（复位后链路回到 Detect）',
      '链路必须从 Detect 开始完整重训练（Polling → Configuration → L0），配置上下文全部丢失',
      'Beacon 只用于 L2；L1 的唤醒走 CLKREQ#，两者是相互独立的路径',
    ],
  },
  wake: {
    title: 'WAKE# · 边带唤醒（Beacon 的替代）',
    meaning: 'WAKE# 是开漏、低有效的边带信号。设备拉低 WAKE# 即可请求平台恢复主电源，不依赖 Beacon 检测电路，也不需要链路时钟。与 Beacon 二选一，取决于平台与设备支持。',
    points: [
      '电气：open-drain 低有效，需要上拉；平台侧检测电路常驻 Vaux 供电',
      '典型使用：D3cold、L2 等主电源已移除的状态',
      '平台收到后恢复主电源 / REF CLK，并释放复位',
      '之后与 Beacon 路径相同：从 Detect 重新训练到 L0',
      '优势：实现简单、唤醒可靠；代价：多一根边带引脚',
    ],
  },
  pme: {
    title: 'PME / PM_PME · 唤醒原因上报',
    meaning: 'PME 是“事件通知”，不是把链路从低功耗拉起来的物理信号。设备先被唤醒并回到 L0，再用 PM_PME 消息告诉软件发生了什么；D3cold / L2 下必须先靠 Beacon 或 WAKE# 恢复电源，PM_PME 才发得出去。',
    points: [
      'PMCSR.PME_En 使能；PME_Status 记录挂起状态（RW1C）',
      'D3hot / D1 / D2：可直接置 PME_Status 并发 PM_PME',
      'D3cold / L2：需 Beacon / WAKE# 先恢复主电源，链路回到 L0 后才能发送',
      'PM_PME 是 Message（code 0x18），走正常 TLP 路径，可被 AER / 中断上报',
      'RC 收到后转成系统中断，软件读 PMCSR 并写 1 清除 PME_Status',
      '一句话：Beacon / WAKE# / CLKREQ# 负责“把链路拉起来”，PM_PME 负责“说明为什么醒”',
    ],
  },
  hotplug: {
    title: 'Hot-Plug · 热插拔信号与流程',
    meaning: '热插拔允许系统在带电状态下插入 / 拔出设备。由槽位（Downstream Port）的 PRSNT#、Attention Button、Power Controller、PERST# 与指示灯配合完成上电/断电与链路重建，再通过 Slot Status 的 DLLSC 与热插拔中断通知软件。',
    points: [
      'PRSNT#：插卡在位检测（0 = 在位），是插入 / 拔出事件的源头',
      'Power Controller：软件写 Slot Control 给槽位上电或断电；Power Fault 上报过流',
      'PERST#：电源稳定后才释放 Fundamental Reset，否则链路训练会失败',
      '上电时序：PRSNT# → 槽位电源 → 电源稳定 → PERST# 释放 → Detect 训练到 L0',
      'DLLSC：链路 Link Up / Link Down 时置位 Slot Status.DLLSC，并产生热插拔中断',
      '安全拔出：Attention Button（ATNBTN#）请求 → Power Indicator 闪烁 → 软件停访问 → 断电 → MRL 开锁拔卡',
      '热插拔是槽位能力，与设备 D 状态无关；D3cold 插卡同样走这条流程',
    ],
  },
  dpc: {
    title: 'DPC · Downstream Port Containment',
    meaning: '下游端口检测到未屏蔽的不可纠正错误后，由硬件自动把链路“关闸”隔离，防止错误数据继续扩散。它属于系统性 RAS 机制：AER 负责“上报”，DPC 负责“先隔离再上报”。',
    points: [
      '触发源：ERR_FATAL / ERR_NONFATAL（按 DPC Control 配置）、Poisoned TLP、Completion Timeout 等不可纠正错误',
      '触发后 DPC Status.Triggered=1，Trigger Reason 记录原因，并产生 DPC 中断通知软件',
      '核心动作：链路进入 DL_Down / Disable（LTSSM → Disable），切断与下游设备的一切通信',
      '隔离期间 Root Port 停止向下游转发 TLP；后续请求由 Egress Control 与 RP PIO 处理',
      '恢复：软件读 DPC Status / Error Source ID → 写 DPC Control.Trigger=0 清除 → Hot Reset → 重新训练与枚举',
      '相关寄存器：DPC Capability / DPC Control / DPC Status / DPC Error Source ID',
    ],
  },
  rppio: {
    title: 'RP PIO · Root Port Programmed I/O Error Controls',
    meaning: 'RP PIO 是 DPC 的精细化扩展，专门约束 Root Port 自身发起的 PIO 请求（CPU 经 RP 读写下游的 Config / IO / Memory 空间）遇到错误时的行为；它不处理下游设备主动上报的 TLP 错误，那些走 AER。',
    points: [
      '作用对象：RP 发起的 PIO 请求，错误类型 UR（Unsupported Request）/ CA（Completer Abort）/ CTO（Completion Timeout）',
      '可按「地址空间（Config / IO / Memory）× 错误类型」独立配置严重级别与是否触发',
      '配置为 Fatal / Non-Fatal：上报错误并按配置触发 DPC，链路被隔离',
      '配置为 Advisory（建议性）：不触发 DPC，仅记录日志并让读请求返回全 1 数据，避免热插拔/探测设备时误伤正常链路',
      'RP PIO Log 记录 Requester ID / Tag / 地址空间与错误类型，供软件定位',
      '一句话：DPC 是宏观“防火墙”，RP PIO 是微观“精细控制器”——决定 PIO 错误是切断链路还是记录后继续',
    ],
  },
  egress: {
    title: 'Egress Control · 下游发送闸门',
    meaning: 'DPC 触发后阻止下游端口继续发送 TLP 的硬件闸门。它只作用在出方向（Root Port → 下游设备），入方向流量已被链路隔离（DL_Down）阻断。',
    points: [
      'DPC Control.Egress Control Enable=1 时生效',
      '被阻止的 TLP 会被计数；若使能 RP PIO，则由其按配置返回错误 Completion（读数据为全 1）',
      '可配合 DPC Control 的 TLP 类型 / 流量类别范围限定阻止对象',
      '目的：错误状态下不再让任何请求继续影响下游设备或系统内存',
    ],
  },
  ats: {
    title: 'ATS · Address Translation Services',
    meaning: '设备做 DMA 前把虚拟地址（VA）交给 RC / IOMMU 翻译成物理地址（PA），并把结果缓存在设备侧 ATC。这样后续访问不必每次都经过 IOMMU，降低 DMA 延迟；地址合法性仍由 IOMMU 统一把关。',
    points: [
      'ATS Capability（0x0F）+ ATS Control：Enable、STU（Smallest Translation Unit，最小翻译粒度）',
      'Translation Request：MRd 格式、AT=01b，携带未翻译地址（VA）与 Tag，不产生内存访问',
      'Translation Completion：Translated=1 时返回 PA；设备可写入 ATC',
      '后续访问 AT=10b，TLP 直接携带物理地址，RC 不再翻译',
      'ATC 一致性依赖 Invalidate：页表改变时 RC / IOMMU 必须让设备缓存失效',
      '非法或越界请求 → Translation Completion Status=UR（Invalid Request），设备不得写入 ATC',
    ],
  },
  pri: {
    title: 'PRI · Page Request Interface',
    meaning: '设备访问的页尚未建立映射时，ATS 翻译无法完成。PRI 允许设备主动上报缺页（Page Request），由 RC / IOMMU 建立映射后回 PRG Response，设备再重试翻译——避免设备挂死，也不需要软件代跑整个访问。',
    points: [
      'PRI Capability（0x13）+ PRI Control：Enable、PRG Response 相关配置',
      'Page Request：Message 0x04，携带 Page Request Group Index 与缺页描述符（VA、读/写）',
      'RC / IOMMU 缺页处理：分配物理页并更新页表（软件或硬件路径）',
      'PRG Response：Message 0x05，Response Code = Success / Invalid Request / Failure',
      '成功后设备重发 Translation Request；失败则终止本次访问并上报',
      '与 ATS 分工：ATS 负责“已映射”的快路径，PRI 负责“未映射”的慢路径',
    ],
  },
  atc: {
    title: 'ATC · Address Translation Cache 与 Invalidate',
    meaning: 'ATC 是设备内部的 VA→PA 翻译缓存，命中时省掉一次到 IOMMU 的往返。它缓存的是“翻译结果”而不是数据，因此页表一旦改变必须失效，否则设备会用旧映射访问到错误物理页。',
    points: [
      '条目按 STU 粒度（如 4 KB）缓存，仅对已允许翻译的地址空间生效',
      '命中：直接以 AT=10b 发起访问；未命中：发 Translation Request',
      'Invalidate Request：Message 0x20，可指定单地址、地址范围或 Global Invalidate（整表）',
      '设备清除对应条目后回 Invalidate Completion：Message 0x21，携带匹配的 ITag',
      'Invalidate 完成前，设备不得继续使用旧翻译；完成后下一次访问重新翻译',
    ],
  },
  lpbkInt: {
    title: 'Internal Loopback · 内部（近端 / 数字）环回',
    meaning: 'TX 数据在器件内部直接回送到 RX，不需要对端设备或环回插头。它属于器件自测模式，不经过 LTSSM 的 Loopback 状态，链路可以始终保持在 L0。',
    points: [
      '回环点：TX 串行化之后 → RX 采样判决之前（同一器件内）',
      '覆盖：SerDes、PLL、CDR、TX/RX 均衡器自身的发送与接收通路',
      '不覆盖：封装、PCB、连接器、线缆——通道损耗按 0 dB 计',
      '常用短序列（如 PRBS7）快速锁定，适合 bring-up 阶段的第一轮自检',
      '结论解读：Internal PASS 只说明器件自身正常，不能证明链路可用',
    ],
  },
  lpbkExt: {
    title: 'External Loopback · 外部（远端 / 串行）环回',
    meaning: '回环点在对端设备（Loopback Slave）或环回插头上，发送数据经整条通道后返回。它是链路电气与通道裕量验证的主要手段，与 Internal 是两套独立配置。',
    points: [
      '建立：RC 发送 Training Control.Loopback=1 的 TS1，EP 连续收到 2 个后进入 Loopback Slave',
      '回环路径：RC TX → 封装 / PCB / 连接器 / 线缆 → EP RX → EP TX → 原路返回 → RC RX',
      '覆盖：通道插损（本模型 12 dB）、反射、串扰、连接器阻抗不连续',
      '常用长序列（如 PRBS31）覆盖更长的连 0/1 与低频成分，更易暴露 AC 耦合问题',
      '结论解读：External PASS 才说明“器件 + 通道”整体满足裕量；结束后链路回 Detect 重新训练',
    ],
  },
  pattern: {
    title: 'BERT 图案 · PRBS 选择与判定',
    meaning: 'PRBS 由 LFSR 生成，周期为 2^n−1。序列长度决定锁定速度与频谱覆盖：短序列锁定快但连 0/1 短；长序列更接近真实流量，更能暴露低频损耗与 AC 耦合。',
    points: [
      'PRBS7：x^7 + x^6 + 1，周期 127 bit，用于 Internal 近端快速自检',
      'PRBS9：x^9 + x^5 + 1，周期 511 bit；PRBS11：x^11 + x^9 + 1，周期 2047 bit（8b/10b 链路常用）',
      'PRBS15：x^15 + x^14 + 1，周期 32767 bit；PRBS23：x^23 + x^18 + 1，周期 8 388 607 bit',
      'PRBS31：x^31 + x^28 + 1，周期 2 147 483 647 bit，PCIe BERT 最常用',
      'BER = 错误数 / 累计比特；本模型目标 BER 1e-12，超过即判 FAIL',
      'BERT 弹窗内可查看所有图案的多项式、序列长度与适用场景',
    ],
  },
};

const EYE_CONCEPTS = {
  height: {
    title: '眼高 · Eye Height',
    meaning: '眼图在垂直方向张开的高度（mV），表示采样时刻区分 0 / 1 的电压余量。眼高越大，抗噪声、串扰与反射的能力越强；眼高不足会直接抬升误码率。',
    value: (s) => (s.metrics.pam4
      ? `单眼 ${s.metrics.eyeHeightPerEyeMv.toFixed(0)} mV × 3（等效 ${s.metrics.eyeHeightMv.toFixed(0)} mV）`
      : `${s.metrics.eyeHeightMv.toFixed(0)} mV`),
  },
  width: {
    title: '眼宽 · Eye Width',
    meaning: '眼图在水平方向张开的宽度（ps），表示采样时钟可左右偏移而不误判的时间余量。眼宽越大，对 jitter、CDR 相位误差与频偏的容忍度越高。',
    formula: (s) => {
      const ui = s.metrics.uiPs;
      const eff = s.metrics.eyeOpening > 0 ? s.metrics.eyeEff / s.metrics.eyeOpening : 0;
      const F = Math.max(0.04, Math.min(1, (s.metrics.eyeEff - 0.05) / 0.75));
      return [
        'UI = 1000 / 数据速率  (ps)',
        'F = clamp((E_eff − 0.05) / 0.75, 0.04, 1)，E_eff = E × F_CDR',
        '眼宽 = UI × (0.2 + 0.65 × F)',
        `代入：UI = ${ui.toFixed(1)} ps，E = ${s.metrics.eyeOpening.toFixed(2)}，F_CDR = ${eff.toFixed(2)}`,
        `→ F = ${F.toFixed(2)}，眼宽 = ${(ui * (0.2 + 0.65 * F)).toFixed(0)} ps`,
      ];
    },
    value: (s) => `${s.metrics.eyeWidthPs.toFixed(0)} ps（UI ${s.metrics.uiPs.toFixed(0)} ps，占 ${((s.metrics.eyeWidthPs / s.metrics.uiPs) * 100).toFixed(0)}%）`,
  },
  opening: {
    title: '眼开度 · Eye Opening',
    meaning: '归一化的眼张开程度（0–1），由 Tx FFE、信道 ISI、RX CTLE/DFE 与 CDR 锁定状态共同决定；用于换算 COM 与 BER，是判断链路是否可用的中间量。',
    value: (s) => `${(s.metrics.eyeOpening * 100).toFixed(0)}%（含 CDR 后有效 ${(s.metrics.eyeEff * 100).toFixed(0)}%）`,
  },
  mask: {
    title: '眼模 · Eye Mask（红色虚线菱形）',
    meaning: '眼模是“电压-时间”平面上的禁区，位于采样点附近，由规范按速率与代际定义。它代表允许的噪声、ISI 与 jitter 总裕量边界：任何波形轨迹进入眼模，说明该处判决裕量不足，实际链路可能误码。测试时把大量 UI 叠加成眼图，检查轨迹不穿模即为 PASS。本图为教学简化的菱形，真实规范眼模是分段多边形。',
    formulaLabel: '判定规则',
    formula: [
      '轨迹 ∩ 眼模 = ∅ → PASS',
      '轨迹 ∩ 眼模 ≠ ∅ → FAIL（判决裕量不足）',
      '眼模尺寸随代际 / 速率由规范规定（示意图为简化菱形）',
    ],
    value: () => '图中红色虚线菱形（采样点附近，可点击）',
  },
  ui: {
    title: 'UI · Unit Interval 单位间隔',
    meaning: '一个比特（NRZ）或一个符号（PAM4）在链路上占用的时间宽度，UI = 1 / 数据速率。它是眼宽、jitter 与采样相位的度量基准：眼宽常用 ps 或 UI 表示，jitter 常用 UI 的百分比描述。',
    value: (s) => `${s.metrics.uiPs.toFixed(1)} ps（${s.rateGts} GT/s；${s.metrics.pam4 ? 'PAM4 每符号 2 bit' : 'NRZ 每符号 1 bit'}）`,
  },
};

let eyeNoise = 0;
let eyeView = null;
let mechKey = '';

/** 说明面板中的“机制”入口：按场景显示可点击按钮，浮窗解释机制。 */
function renderMechanism() {
  const el = $('scenarioMechanism');
  const defs = SCENARIO_MECH[scenarioKey];
  if (!defs) {
    el.hidden = true;
    el.innerHTML = '';
    mechKey = '';
    return;
  }
  el.hidden = false;
  if (mechKey === scenarioKey) return;
  mechKey = scenarioKey;
  el.innerHTML = `<span class="mech-label">机制</span>${defs
    .map(([k, label]) => `<button type="button" class="target-chip" data-mech="${k}">${escHtml(label)}</button>`)
    .join('')}`;
  el.querySelectorAll('[data-mech]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = MECH_INFO[btn.dataset.mech];
      if (!m) return;
      showInfoPop(btn, `<div class="arch-pop-head">
          <b>${escHtml(m.title)}</b>
          <button class="icon-btn" type="button" data-pop-close aria-label="关闭">×</button>
        </div>
        <div class="arch-pop-sec">
          <span class="arch-pop-label">定义与作用</span>
          <p class="arch-pop-mean">${escHtml(m.meaning)}</p>
        </div>
        <div class="arch-pop-sec">
          <span class="arch-pop-label">机制要点</span>
          <div class="arch-pop-formula">${m.points.map((p) => `<div>${escHtml(p)}</div>`).join('')}</div>
        </div>`);
    });
  });
}

/** 噪声对眼图指标的影响（教学模型：压缩眼高/眼宽并降低 COM）。 */
function applyEyeNoise(m, n) {
  if (n <= 0) return m;
  const open = Math.max(0.05, m.eyeOpening * (1 - 0.4 * n));
  const eff = Math.max(0.05, m.eyeEff * (1 - 0.4 * n));
  const comDb = m.comDb - 7 * n;
  return {
    ...m,
    eyeOpening: open,
    eyeEff: eff,
    comDb,
    comPass: comDb >= 3,
    ber: Math.min(0.5, Math.pow(10, -(comDb / 1.8 + 2))),
    eyeHeightMv: m.eyeHeightMv * (1 - 0.5 * n),
    eyeHeightPerEyeMv: (m.eyeHeightPerEyeMv ?? m.eyeHeightMv / 3) * (1 - 0.5 * n),
    eyeWidthPs: m.eyeWidthPs * (1 - 0.45 * n),
  };
}

function pam4PreviewMetrics(s) {
  const uiPs = 1000 / GEN_RATE[6];
  const eyeFactor = Math.max(0.04, Math.min(1, (s.metrics.eyeEff - 0.05) / 0.75));
  const eyeWidthPs = uiPs * (0.2 + 0.65 * eyeFactor);
  const comDb = 20 * Math.log10(Math.max(0.01, s.metrics.eyeOpening)) + 10 + 3 - s.cdrPenaltyDb;
  return {
    ...s.metrics,
    pam4: true,
    eyeCount: 3,
    modulation: 'PAM4',
    uiPs,
    eyeWidthPs,
    eyeHeightPerEyeMv: s.metrics.eyeHeightMv / 3,
    comDb,
    comPass: comDb >= 3,
    ber: Math.min(0.5, Math.pow(10, -(comDb / 1.8 + 2))),
  };
}

function eyeRowsHtml(met, s, previewPam4) {
  return [
    ['TX 摆幅', `+${s.txDb.toFixed(1)} dB`],
    ['信道损耗', `-${s.channel.lossDb.toFixed(1)} dB`],
    ['噪声 / 串扰 / 反射', `-${s.noiseDb.toFixed(1)} dB`],
    ['TX FFE 增益', `+${s.eqGainDb.toFixed(1)} dB`],
    ['FEC 增益', `${previewPam4 ? '+3.0' : (s.fecGainDb ? `+${s.fecGainDb.toFixed(1)}` : '0')} dB`],
    ['CDR 惩罚', `-${s.cdrPenaltyDb.toFixed(1)} dB`],
    ['均衡后眼开度', `${(met.eyeOpening * 100).toFixed(0)}%`],
    ['COM', `${met.comDb.toFixed(1)} dB（阈值 3.0 dB）`],
  ].map(([k, v]) => `<tr><td>${escHtml(k)}</td><td>${escHtml(v)}</td></tr>`).join('');
}

function eyeKvHtml(met, s, previewPam4) {
  return [
    ['速率', previewPam4
      ? `${s.rateGts} GT/s（目标 ${GEN_RATE[s.gen]} GT/s）`
      : `${s.rateGts} GT/s`],
    ['调制', met.pam4 ? `PAM4（4 电平 · 上/中/下 3 eye${previewPam4 ? ' · 目标预演' : ''}）` : 'NRZ（2 电平 · 1 eye）'],
    ['CDR', s.cdr.state],
    ['EQ', `Phase ${s.eq.phase} · ${s.eq.name}（pre ${s.eq.pre.toFixed(2)} / cursor ${s.eq.cursor.toFixed(2)} / post ${s.eq.post.toFixed(2)}）`],
    ['RX EQ', `CTLE ${s.rxEq.ctleDb} dB · DFE ${s.rxEq.dfeTaps} tap`],
    ['信道 ISI', `pre ${s.channel.preIsi.toFixed(2)} / post ${s.channel.postIsi.toFixed(2)}`],
    ['眼高', met.pam4
      ? `单眼 ${met.eyeHeightPerEyeMv.toFixed(0)} mV × 3（等效 ${met.eyeHeightMv.toFixed(0)} mV）`
      : `${met.eyeHeightMv.toFixed(0)} mV`],
    ['眼宽', `${met.eyeWidthPs.toFixed(0)} ps（UI ${met.uiPs.toFixed(1)} ps）`],
    ['BER', met.ber.toExponential(1)],
  ].map(([k, v]) => `<div><dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd></div>`).join('');
}

function openEye() {
  const s = sim.phy.snapshot();
  modalMode = 'eye';
  $('modalTitle').textContent = 'PHY 眼图与链路预算';

  // 目标 Gen6 但仍在 2.5 GT/s 工作时，按目标 PAM4 预演三 eye
  const previewPam4 = s.gen === 6 && !s.metrics.pam4;
  const baseMet = previewPam4 ? pam4PreviewMetrics(s) : s.metrics;
  eyeNoise = 0;
  eyeView = { ...s, metrics: baseMet, rateGts: previewPam4 ? GEN_RATE[6] : s.rateGts };

  const notice = previewPam4
    ? `<p class="hint eye-notice">当前工作点 ${s.rateGts} GT/s 为 NRZ；以下按<b>目标 Gen6 · 64 GT/s（PAM4 三 eye）</b>预演。
       眼高 / 眼宽按当前均衡结果折算，完成 Recovery.Speed 后自动切换为实际 PAM4 眼图。</p>`
    : '';

  // 眼图 ↔ 符号编码映射（参考 PCIe 6.2）
  const encRows = [
    ['Gen1–2', '8b/10b', '1 bit', 'NRZ · 2 电平', '1 eye', '1（0 V）'],
    ['Gen3–5', '128b/130b', '1 bit', 'NRZ · 2 电平', '1 eye', '1（0 V）'],
    ['Gen6', '1b/1b + FEC', '2 bit', 'PAM4 · 4 电平', '3 eye', '3（Gray）'],
  ].map(([g, code, bits, levels, eyes, thr]) => {
    const active = (g === 'Gen1–2' && s.gen <= 2)
      || (g === 'Gen3–5' && s.gen >= 3 && s.gen <= 5)
      || (g === 'Gen6' && s.gen === 6);
    return `<tr class="${active ? 'row-active' : ''}"><td>${g}</td><td>${code}</td><td>${bits}</td>
      <td>${levels}</td><td>${eyes}</td><td>${thr}</td></tr>`;
  }).join('');

  const symChips = (baseMet.pam4 ? ['L3 = 10', 'L2 = 11', 'L1 = 01', 'L0 = 00'] : ['L1 = 1', 'L0 = 0'])
    .map((t) => `<span class="eye-sym">${t}</span>`).join('');

  const encodeBlock = `<div class="eye-encode">
    <p class="model-sect">符号编码映射 <span>参考 PCIe 6.2：NRZ 1 bit/符号，PAM4 Gray 编码 2 bit/符号</span></p>
    ${baseMet.pam4 ? `<p class="model-sect" style="margin-top:2px">PAM4 UI 级信号 <span>参考 PCIe 6.2 Figure 4-24</span></p>
      <div class="eye-figure">${pam4UiSvg()}</div>` : ''}
    <div class="eye-sym-row">${symChips}<span class="hint-inline">${baseMet.pam4
    ? 'Gray 编码：相邻电平仅 1 bit 不同；3 个判决阈值'
    : '单阈值判决：高于门限为 1，低于为 0'}</span></div>
    <div class="table-scroll">
      <table class="compare">
        <thead><tr><th>代际</th><th>线码</th><th>bit / 符号</th><th>调制</th><th>眼数</th><th>判决阈值</th></tr></thead>
        <tbody>${encRows}</tbody>
      </table>
    </div>
    <p class="hint">眼图是符号在时域上的叠加：NRZ 每符号 1 bit，眼图只有上下两个电平；PAM4 每符号 2 bit，
      4 个电平形成上 / 中 / 下三个眼，接收端用 3 个阈值切片恢复 Gray 编码的符号。</p>
  </div>`;

  const concepts = [['height', '眼高'], ['width', '眼宽'], ['ui', 'UI'], ['opening', '眼开度'], ['mask', '眼模']]
    .map(([k, label]) => `<button type="button" class="target-chip" data-eye="${k}">${label}</button>`)
    .join('');

  modalBody.innerHTML = `<div class="eye-large" id="eyeSvgWrap">${eyeSvg(baseMet, { width: 640, height: 240, noise: eyeNoise })}</div>
    ${notice}
    <div class="eye-noise">
      <label>噪声 <input type="range" id="eyeNoiseRange" min="0" max="100" step="5" value="0"></label>
      <span id="eyeNoiseLabel">0%</span>
      <span class="hint-inline">眼图已叠加高斯白噪声（AWGN）与随机抖动，形似真实示波器 / 协议分析仪；加大噪声会压缩眼高/眼宽并降低 COM</span>
    </div>
    <div class="eye-concepts">${concepts}<span class="hint-inline">点击查看定义、计算方式与物理意义</span></div>
    <p class="hint">眼宽 = UI × (0.2 + 0.65·F)，其中 F = clamp((E_eff − 0.05)/0.75, 0.04, 1)，E_eff 由眼开度与 CDR 锁定状态决定。</p>
    <dl class="kv" id="eyeKv">${eyeKvHtml(baseMet, s, previewPam4)}</dl>
    <table class="compare" style="margin-top:12px">
      <thead><tr><th>链路预算项</th><th>数值</th></tr></thead>
      <tbody id="eyeRows">${eyeRowsHtml(baseMet, s, previewPam4)}</tbody>
    </table>
    ${encodeBlock}
    <p class="hint">教学简化模型：3 抽头 TX FFE + RX CTLE/DFE 抵消信道 ISI；COM = 20log10(眼开度) + 10 + FEC − CDR 惩罚。
      ${baseMet.pam4 ? 'Gen6 64 GT/s 采用 PAM4：4 电平形成上/中/下三个眼，单眼高度约为 NRZ 等效摆幅的 1/3，眼图为三 eye。' : '绝对数值不代表真实信道仿真。'}</p>`;

  modalBody.querySelectorAll('[data-eye]').forEach((btn) => {
    const openConcept = (e) => {
      e.stopPropagation();
      const c = EYE_CONCEPTS[btn.dataset.eye];
      if (!c) return;
      showInfoPop(btn, `<div class="arch-pop-head">
          <b>${escHtml(c.title)}</b>
          <button class="icon-btn" type="button" data-pop-close aria-label="关闭">×</button>
        </div>
        <div class="arch-pop-sec">
          <span class="arch-pop-label">定义与物理意义</span>
          <p class="arch-pop-mean">${escHtml(c.meaning)}</p>
        </div>
        ${c.formula ? `<div class="arch-pop-sec">
          <span class="arch-pop-label">${escHtml(c.formulaLabel || '计算方式')}</span>
          <div class="arch-pop-formula">${(typeof c.formula === 'function' ? c.formula(eyeView) : c.formula)
    .map((f) => `<div>${escHtml(f)}</div>`).join('')}</div>
        </div>` : ''}
        <div class="arch-pop-sec">
          <span class="arch-pop-label">当前数值</span>
          <div class="arch-pop-val">${escHtml(c.value(eyeView))}</div>
        </div>`);
    };
    btn.addEventListener('click', openConcept);
    if (btn.tagName !== 'BUTTON') {
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openConcept(e);
        }
      });
    }
  });

  // 噪声滑块：只更新眼图与指标，不重建弹窗，拖动不中断
  const range = $('eyeNoiseRange');
  range.addEventListener('input', () => {
    eyeNoise = Number(range.value) / 100;
    $('eyeNoiseLabel').textContent = `${Math.round(eyeNoise * 100)}%`;
    const noisy = applyEyeNoise(baseMet, eyeNoise);
    eyeView = { ...eyeView, metrics: noisy };
    $('eyeSvgWrap').innerHTML = eyeSvg(noisy, { width: 640, height: 240, noise: eyeNoise });
    $('eyeKv').innerHTML = eyeKvHtml(noisy, s, previewPam4);
    $('eyeRows').innerHTML = eyeRowsHtml(noisy, s, previewPam4);
  });

  modal.hidden = false;
}

function openBert() {
  const b = sim.bert.snapshot();
  modalMode = 'bert';
  $('modalTitle').textContent = 'BERT 误码测试';
  if (!b.enabled) {
    modalBody.innerHTML = '<p class="empty">当前场景未启用 BERT，请选择“Loopback / BERT（误码测试）”场景。</p>';
    modal.hidden = false;
    return;
  }
  const kv = [
    ['图案', `${b.pattern}（${b.polynomial}）`],
    ['环回模式', (() => {
      const lb = sim.loopback ? sim.loopback.snapshot() : { mode: 'none', channelLossDb: 0 };
      return loopbackLabel(lb.mode, lb.channelLossDb);
    })()],
    ['锁定', b.locked ? '已锁定' : '未锁定'],
    ['累计比特', formatBits(b.bits)],
    ['错误数', String(b.errors)],
    ['BER', b.errors === 0 ? '0' : b.ber.toExponential(2)],
    ['目标 BER', b.targetBer.toExponential(0)],
    ['结果', b.pass ? 'PASS' : 'FAIL'],
  ].map(([k, v]) => `<div><dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd></div>`).join('');

  const patternRows = BERT_PATTERN_ORDER.map((n) => {
    const p = BERT_PATTERNS[n];
    return `<tr class="${n === b.pattern ? 'on' : ''}">
      <td>${n}</td>
      <td class="mono">${escHtml(p.polynomial)}</td>
      <td>2^${p.order}−1 = ${p.period.toLocaleString('en-US')}</td>
      <td class="sym-desc">${escHtml(p.note)}</td>
    </tr>`;
  }).join('');

  const history = b.history.map((h, i) => `<tr>
    <td>${i + 1}</td>
    <td>${h.kind === 'inject' ? '注入错误' : '测量窗口'}</td>
    <td>${formatBits(h.bits)}</td>
    <td>${h.errors}</td>
    <td>${h.ber === 0 ? '0' : h.ber.toExponential(2)}</td>
  </tr>`).join('');

  const injText = b.injections.length
    ? b.injections.map((h) => `${h.errors} errors @ ${formatBits(h.bitsAt)}，BER ${h.ber.toExponential(1)}`).join('；')
    : '无';

  modalBody.innerHTML = `<dl class="kv">${kv}</dl>
    <div class="insp-section">
      <h3>PRBS 图案</h3>
      <div class="table-scroll">
        <table class="symbols">
          <colgroup><col style="width:74px"><col style="width:150px"><col style="width:190px"><col></colgroup>
          <thead><tr><th>图案</th><th>多项式</th><th>序列长度（bit）</th><th>适用</th></tr></thead>
          <tbody>${patternRows}</tbody>
        </table>
      </div>
    </div>
    <div class="table-scroll tall" style="margin-top:12px">
      <table class="symbols">
        <colgroup><col style="width:40px"><col style="width:96px"><col><col style="width:64px"><col style="width:96px"></colgroup>
        <thead><tr><th>#</th><th>类型</th><th>累计比特</th><th>错误</th><th>BER</th></tr></thead>
        <tbody>${history}</tbody>
      </table>
    </div>
    <p class="hint">注入记录：${escHtml(injText)}</p>
    <p class="hint">PRBS 图案由 LFSR 生成；BER = 错误数 / 累计比特。目标 BER 1e-12。</p>`;
  modal.hidden = false;
}

function openIrq() {
  const m = sim.msi.snapshot();
  const a = sim.aer.snapshot();
  modalMode = 'irq';
  $('modalTitle').textContent = '中断 / AER 详情';

  const kv = [
    ['MSI', m.msiEnabled ? `使能 · ${m.vectorCount} 向量 · 地址 0x${m.msiAddress.toString(16).toUpperCase()}` : '关闭'],
    ['MSI-X', m.msixEnabled ? `使能 · ${m.msixTable.length} 表项` : '关闭'],
    ['中断次数', String(m.interrupts.length)],
    ['被屏蔽', String(m.suppressed)],
    ['AER', a.enabled ? '使能' : '关闭'],
  ].map(([k, v]) => `<div><dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd></div>`).join('');

  const msixRows = m.msixTable.map((e) => `<tr>
    <td>${e.index}</td>
    <td>0x${e.address.toString(16).toUpperCase()}</td>
    <td>0x${e.data.toString(16).toUpperCase()}</td>
    <td>${e.masked ? 'mask' : '使能'}</td>
  </tr>`).join('');

  const aerRows = a.log.length
    ? a.log.map((r, i) => `<tr><td>${i + 1}</td><td>${escHtml(r.severity)}</td><td>${escHtml(r.message)}</td></tr>`).join('')
    : '<tr><td colspan="3">暂无错误</td></tr>';

  modalBody.innerHTML = `<dl class="kv">${kv}</dl>
    <div class="insp-section">
      <h3>MSI-X 表</h3>
      <div class="table-scroll">
        <table class="symbols">
          <colgroup><col style="width:44px"><col><col><col style="width:64px"></colgroup>
          <thead><tr><th>#</th><th>Message Address</th><th>Message Data</th><th>Mask</th></tr></thead>
          <tbody>${msixRows}</tbody>
        </table>
      </div>
    </div>
    <div class="insp-section">
      <h3>AER 错误日志</h3>
      <div class="table-scroll">
        <table class="symbols">
          <colgroup><col style="width:44px"><col style="width:90px"><col></colgroup>
          <thead><tr><th>#</th><th>严重度</th><th>错误</th></tr></thead>
          <tbody>${aerRows}</tbody>
        </table>
      </div>
    </div>
    <p class="hint">Correctable 通过 ERR_COR 上报；Uncorrectable 分为 Non-Fatal（ERR_NONFATAL）与 Fatal（ERR_FATAL）。</p>`;
  modal.hidden = false;
}

function openPm() {
  const p = sim.pm.snapshot();
  modalMode = 'pm';
  $('modalTitle').textContent = '电源管理 L / D / P 状态';
  const linkNow = (sim.link && sim.link.ports && sim.link.ports.RC && sim.link.ports.RC.state)
    || p.linkState;
  const kv = [
    ['当前状态', p.dstate === 'D0' ? `D0 · ${p.pstateName}` : p.dstate],
    ['功耗', `${p.powerW.toFixed(1)} W`],
    ['PMCSR', `0x${p.pmcsr.toString(16).toUpperCase().padStart(4, '0')}`],
    ['PME_En', p.pmeEn ? '1' : '0'],
    ['PME_Status', p.pmeStatus ? '1' : '0'],
    ['链路', linkNow],
  ].map(([k, v]) => `<div><dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd></div>`).join('');

  // L 状态：状态 | 定义 | 主电源 | REF CLK | 唤醒 / 退出 | 退出延迟
  const lRows = L_STATE_ROWS.map(([name, def, pw, clk, , wake, delay]) => `<tr class="${name === linkNow ? 'on' : ''}">
    <td>${name}</td><td>${escHtml(def)}</td><td>${escHtml(pw)}</td>
    <td>${escHtml(clk)}</td><td>${escHtml(wake)}</td><td>${escHtml(delay)}</td>
  </tr>`).join('');

  const dRows = p.dStates.map((d) => `<tr class="${d.name === p.dstate ? 'on' : ''}">
    <td>${d.name}</td><td>${d.link}</td>
    <td>${d.powerW === undefined ? 'P 状态决定' : `${d.powerW} W`}</td>
    <td>${escHtml(D_DEF[d.name] ?? d.desc)}</td>
  </tr>`).join('');

  const pRows = p.pStates.map((s, i) => `<tr class="${i === p.pstate && p.dstate === 'D0' ? 'on' : ''}">
    <td>${s.name}</td><td>${escHtml(s.pipe)}</td><td>${escHtml(s.pll)}</td>
    <td>${escHtml(s.clk)}</td><td>${s.powerW} W</td>
    <td>${escHtml(P_DEF[s.name] ?? '')}</td>
  </tr>`).join('');

  const layerRows = PM_LAYERS.map(([layer, src, vis, mean]) => `<tr>
    <td>${escHtml(layer)}</td><td>${escHtml(src)}</td><td>${escHtml(vis)}</td><td>${escHtml(mean)}</td>
  </tr>`).join('');

  const bitRows = PMCSR_BITS.map((b) => {
    const on = ((p.pmcsr >>> b.bit) & 1) === 1;
    return `<tr class="${on ? 'on' : ''}"><td>${b.bit}</td><td>${b.name}</td>
      <td>${on ? '1' : '0'}</td><td>${b.desc}</td></tr>`;
  }).join('');

  modalBody.innerHTML = `<dl class="kv">${kv}</dl>
    <div class="insp-section">
      <h3>三层状态：D / L / P</h3>
      <div class="table-scroll">
        <table class="symbols wrap">
          <colgroup><col style="width:58px"><col><col style="width:140px"><col></colgroup>
          <thead><tr><th>层</th><th>来源 / 控制者</th><th>软件可见性</th><th>含义</th></tr></thead>
          <tbody>${layerRows}</tbody>
        </table>
      </div>
      <p class="hint">D 状态由 PM 软件写 PMCSR 控制，软件可见；L 状态由 D 状态与 ASPM 推导、LTSSM 执行，软件通常不可见；
        P 状态是 PHY/PIPE 的 powerdown 编码，由 PHY 实现，不能与 L1 / L2 画等号。</p>
    </div>
    <div class="insp-section">
      <h3>L 状态（链路电源管理）</h3>
      <div class="table-scroll">
        <table class="symbols wrap">
          <colgroup><col style="width:46px"><col><col style="width:76px"><col style="width:58px">
            <col style="width:150px"><col style="width:60px"></colgroup>
          <thead><tr><th>状态</th><th>定义</th><th>主电源</th><th>REF CLK</th>
            <th>唤醒 / 退出</th><th>退出延迟</th></tr></thead>
          <tbody>${lRows}</tbody>
        </table>
      </div>
      <p class="hint">L0s 仅用于 Non-Flit，用 FTS 快速退出；L0p 仅用于 Flit（Gen6），只关空闲 Lane 子集。
        L1ss 指 L1 Substates（L1.0 / L1.1 / L1.2）：逐步关闭 REF CLK 与 PHY 电源，退出延迟依次增大。</p>
    </div>
    <div class="insp-section">
      <h3>D 状态（软件层）</h3>
      <div class="table-scroll">
        <table class="symbols wrap">
          <colgroup><col style="width:70px"><col style="width:150px"><col style="width:100px"><col></colgroup>
          <thead><tr><th>状态</th><th>链路（推导）</th><th>典型功耗</th><th>定义 / 说明</th></tr></thead>
          <tbody>${dRows}</tbody>
        </table>
      </div>
      <p class="hint">D0 期间链路可在 L0 / L0s / L0p / L1 之间自动切换；D1 / D2 / D3hot 通常推导为 L1；
        D3hot 不等于 L3 —— D3hot 时 Vcc 与 LTSSM 仍在，可写 PMCSR 回 D0，而 L3 时 LTSSM 已断电。</p>
    </div>
    <div class="insp-section">
      <h3>P 状态（PHY / PIPE PowerDown 编码）</h3>
      <div class="table-scroll">
        <table class="symbols wrap">
          <colgroup><col style="width:60px"><col style="width:96px"><col style="width:84px">
            <col style="width:96px"><col style="width:96px"><col></colgroup>
          <thead><tr><th>状态</th><th>PowerDown 编码</th><th>PLL</th><th>PCLK / 时钟</th>
            <th>典型 PHY 功耗</th><th>定义</th></tr></thead>
          <tbody>${pRows}</tbody>
        </table>
      </div>
      <p class="hint">P 状态只描述 PHY 的门控深度，由 PHY 实现、软件不直接控制；同一 P 档可服务不同 L 状态，也不能由 P 档反推 L 状态（P2 ≠ L2）。</p>
    </div>
    <div class="insp-section">
      <h3>PMCSR（PM Capability +0x04）</h3>
      <div class="table-scroll">
        <table class="symbols wrap">
          <colgroup><col style="width:44px"><col style="width:140px"><col style="width:54px"><col></colgroup>
          <thead><tr><th>Bit</th><th>字段</th><th>当前</th><th>说明</th></tr></thead>
          <tbody>${bitRows}</tbody>
        </table>
      </div>
    </div>
    <p class="hint">D3hot 需 PME_En=1 才能发 PME；D3cold 必须经 Fundamental Reset 才能回 D0。
      D 状态软件可见，L 状态由 D + ASPM 推导、软件通常不可见，P 状态是 PHY 的 PIPE PowerDown 编码，三者不能互相等同。</p>`;
  modal.hidden = false;
}

function closeModal(rerender = true) {
  closeArchPop();
  const wasOpen = !modal.hidden;
  modal.hidden = true;
  modalMode = 'event';
  if (wasOpen && rerender) renderAll(false);
}

function renderAll(follow = false) {
  const detail = detailEvent();
  const detailId = detail ? detail.id : null;

  renderTopology($('topology'), sim);
  renderLinkInfo($('linkInfo'), sim);
  renderLTSSM($('ltssm'), sim);
  renderCounters($('counters'), sim);
  $('counterTitle').textContent = sim.fc && sim.fc.enabled ? '流控信用' : '训练计数器';
  renderConfig($('config'), sim);
  renderPhy($('phy'), sim, phyCollapsed);
  renderIrq($('irq'), sim);
  renderPm($('pm'), sim);
  renderFlit($('flit'), sim);
  $('irqPanel').hidden = !(sim.msi.msiEnabled || sim.msi.msixEnabled || sim.aer.enabled);
  $('pmPanel').hidden = !sim.pm.enabled;
  $('flitPanel').hidden = !sim.flit.enabled;
  $('atsPanel').hidden = scenarioKey !== 'ats';
  renderAts($('ats'), sim);

  const vis = PANEL_VIS[scenarioKey] || PANEL_VIS.link_training;
  $('phyPanel').hidden = !vis.phy;
  $('configPanel').hidden = !vis.config;
  $('counterPanel').hidden = !vis.counters;
  $('notesSummary').textContent = SCENARIO_SUMMARY[scenarioKey] || '';
  renderMechanism();
  $('notesBody').hidden = !notesOpen;
  $('notesToggle').textContent = notesOpen ? '收起' : '展开';
  renderLog($('log'), sim, detailId);
  $('logCount').textContent = String(sim.events.length);
  renderInspector($('inspector'), sim, detailId);
  if (!modal.hidden && modalMode === 'event') openModal(detailId);
  if (!modal.hidden && modalMode === 'model') {
    // 暂停/单步时实时刷新；播放时仅在阶段变化（EQ Phase / CDR 状态）时自动切换
    const phaseKey = `${sim.phy.eq.phase}|${sim.phy.cdr.state}|${sim.phy.pll.locked ? 1 : 0}`
      + `|${sim.pm.dstate}|${sim.pm.pstate}|${sim.link.ports.RC.state}|${sim.hotplug.presence}`;
    if (!running || phaseKey !== modelPhaseKey) {
      renderModelBody();
      modelPhaseKey = phaseKey;
    }
  }
  timeline.render(detailId, follow, selectedRow, !running && modal.hidden && !flowMode);
  if (flowMode) {
    flowView.setSim(sim, scenarioKey);
    flowView.render({ currentTime: sim.clock, selectedId: detailId, follow });
  }
  updateTargetChip();
  updateStatus();
  btnStep.disabled = running || sim.finished;
  btnBack.disabled = running || sim.history.length === 0;
  btnRun.textContent = running ? '暂停' : (sim.finished ? '重新运行' : '运行');
}

function updateStatus() {
  const phase = sim.currentPhase
    ? sim.currentPhase.label
    : (sim.finished ? '已完成' : '待开始');
  const note = $('status').dataset.note;
  const speedText = elSpeed.selectedOptions[0] ? elSpeed.selectedOptions[0].textContent : '';
  $('status').textContent = `t = ${(sim.clock / 1000).toFixed(1)} µs`
    + ` · 事件 ${sim.events.length}`
    + ` · 阶段 ${phase}`
    + (speedText ? ` · 速度 ${speedText}` : '')
    + (note ? ` · ${note}` : '');
  if (sim.finished) $('status').dataset.note = '';
}

function step() {
  if (running || sim.finished) return;
  pinnedId = null;
  sim.stepOnce();
  renderAll(true);
}

function stepBack() {
  if (running) return;
  if (!sim.stepBack()) return;
  pinnedId = null;
  renderAll(true);
}

function setViewMode(mode) {
  flowMode = mode === 'flow';
  $('timeline').hidden = flowMode;
  $('flow').hidden = !flowMode;
  $('legend').hidden = flowMode;
  $('viewTimeline').classList.toggle('active', !flowMode);
  $('viewFlow').classList.toggle('active', flowMode);
  if (flowMode && timeline.hideTip) timeline.hideTip();
  renderAll(true);
}

function stop() {
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function toggleRun() {
  if (running) {
    stop();
    renderAll(false);
    return;
  }
  if (sim.finished) reset();
  running = true;
  pinnedId = null;
  btnRun.textContent = '暂停';
  // 1× = 每 70ms 一步；加速通过每 tick 多步实现，慢放通过拉长 tick 实现。
  const { interval, batch } = playbackTiming(speed);
  timer = setInterval(() => {
    pinnedId = null;
    for (let i = 0; i < batch; i += 1) {
      if (sim.finished) break;
      sim.stepOnce();
    }
    renderAll(true);
    if (sim.finished) {
      stop();
      renderAll(true);
    }
  }, interval);
  renderAll(true);
}

function selectEvent(id) {
  const ev = sim.events.find((e) => e.id === id);
  if (!ev) return;
  selectedRow = ev.row;
  pinnedId = id;
  renderAll(false);
  openModal(id);
}

function selectRow(row) {
  if (selectedRow === row) {
    selectedRow = row === 'STATE' ? null : 'STATE';
  } else {
    selectedRow = row;
  }
  pinnedId = null;
  renderAll(false);
}

function onConfigChange() {
  reset();
}

btnReset.addEventListener('click', reset);
btnBack.addEventListener('click', stepBack);
btnStep.addEventListener('click', step);
btnRun.addEventListener('click', toggleRun);
$('configBtn').addEventListener('click', openConfigDump);
$('eyeBtn').addEventListener('click', openEye);
$('bertBtn').addEventListener('click', openBert);
$('irqBtn').addEventListener('click', openIrq);
$('pmBtn').addEventListener('click', openPm);

// 典型模型菜单：PHY 处理模型 + 链路模式差异
const modelMenu = $('modelMenu');
const modelMenuBtn = $('modelMenuBtn');
const modelMenuList = $('modelMenuList');

function setModelMenu(open) {
  modelMenuList.hidden = !open;
  modelMenuBtn.setAttribute('aria-expanded', String(open));
  modelMenuBtn.textContent = open ? '典型模型 ▴' : '典型模型 ▾';
}
modelMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setModelMenu(modelMenuList.hidden);
});
document.addEventListener('click', (e) => {
  if (!modelMenu.contains(e.target)) setModelMenu(false);
  if (archPop && !archPop.contains(e.target) && !e.target.closest('[data-arch]')) closeArchPop();
});
// 内联卡片是正文的一部分，滚动时不关闭；浮动浮窗随滚动关闭以免错位
modalBody.addEventListener('scroll', () => {
  if (archPop && !archPop.classList.contains('arch-pop-inline')) closeArchPop();
}, { passive: true });
window.addEventListener('resize', closeArchPop);
modelMenuList.addEventListener('click', (e) => {
  const item = e.target.closest('[data-model]');
  if (!item) return;
  setModelMenu(false);
  const open = {
    eq: openEqModel,
    cdr: openCdrModel,
    pll: openPllModel,
    gen: openGenModel,
    pm: openPmModel,
    ras: openRasModel,
    ordering: openOrderingModel,
    eye: openEye,
    bert: openBert,
    compare: openCompare,
  }[item.dataset.model];
  if (open) open();
});
$('phyToggle').addEventListener('click', () => {
  phyCollapsed = !phyCollapsed;
  $('phyToggle').textContent = phyCollapsed ? '展开' : '收起';
  renderAll(false);
});
$('notesToggle').addEventListener('click', () => {
  notesOpen = !notesOpen;
  renderAll(false);
});
$('viewTimeline').addEventListener('click', () => setViewMode('timeline'));
$('viewFlow').addEventListener('click', () => setViewMode('flow'));

// 流程视图宽度自适应：窗口尺寸变化后重新布局（X 固定，仅纵向滚动）
let flowResizeTimer = null;
window.addEventListener('resize', () => {
  if (!flowMode) return;
  clearTimeout(flowResizeTimer);
  flowResizeTimer = setTimeout(() => renderAll(false), 120);
});

$('ltssm').addEventListener('click', (e) => {
  const li = e.target.closest('[data-state]');
  if (li) openStateInfo(li.dataset.state);
});
elScenario.addEventListener('change', () => {
  scenarioKey = elScenario.value;
  phyCollapsed = scenarioKey !== 'phy_link';
  $('phyToggle').textContent = phyCollapsed ? '展开' : '收起';
  reset();
});
elMode.addEventListener('change', reset);
elPattern.addEventListener('change', reset);
elLpbk.addEventListener('change', reset);
elGen.addEventListener('change', onConfigChange);
elWidth.addEventListener('change', onConfigChange);
elSpeed.addEventListener('change', () => {
  speed = Number(elSpeed.value);
  if (running) {
    stop();
    toggleRun();
  } else {
    updateStatus();
  }
});

$('detailTarget').addEventListener('click', () => {
  selectedRow = selectedRow === null ? 'STATE' : null;
  pinnedId = null;
  renderAll(false);
});

$('log').addEventListener('click', (e) => {
  const li = e.target.closest('[data-id]');
  if (li) selectEvent(Number(li.dataset.id));
});

modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});
$('modalClose').addEventListener('click', closeModal);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && archPop) {
    e.preventDefault();
    closeArchPop();
    return;
  }
  if (e.key === 'Escape' && !modelMenuList.hidden) {
    e.preventDefault();
    setModelMenu(false);
    return;
  }
  if (e.key === 'Escape' && !modal.hidden) {
    e.preventDefault();
    closeModal();
    return;
  }
  if (!modal.hidden) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space') {
    e.preventDefault();
    toggleRun();
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    step();
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault();
    stepBack();
  } else if (e.key === 'r' || e.key === 'R') {
    reset();
  }
});

reset();
