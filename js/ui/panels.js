/**
 * 右侧与底部面板：链路参数、LTSSM、计数器、日志、事件详情。
 */
import { LTSSM_TOP } from '../core/link.js';
import { RATE_BY_GEN, encodingOf, hex2, ratesText, ratesCompact } from '../core/packet.js';
import { cdrText, formatBer } from '../core/phy.js';
import { loopbackLabel } from '../core/loopback.js';
import { formatBits } from '../core/bert.js';
import { FC_CLASSES, FC_LABELS } from '../core/fc.js';
import { interpretEvent } from '../core/event_info.js';
import { eyeSvg } from './eye.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function us(v) {
  return (v / 1000).toFixed(v < 10000 ? 1 : 0);
}

export function renderLinkInfo(el, sim) {
  const link = sim.link;
  const rateGen = link.ports.RC.rateGen ?? 1;
  const laneNums = link.ports.RC.laneNumbers;
  const rows = [
    ['目标代际', `Gen${link.targetGen}`],
    ['链路宽度', `x${link.width}`],
    ['线码', encodingOf(link.targetGen)],
    ['数据流模式', link.flitMode ? 'Flit（256B）' : 'Non-Flit'],
    ['当前速率', RATE_BY_GEN[rateGen] ?? RATE_BY_GEN[1]],
    ['链路编号', String(link.ports.RC.linkNumber)],
    ['通道编号', laneNums.length ? `0 … ${laneNums.length - 1}` : '未分配'],
    ['链路状态', link.ports.RC.state],
  ];
  if (link.modeNote) rows.push(['模式说明', link.modeNote]);
  el.innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

export function renderLTSSM(el, sim) {
  const rc = sim.link.ports.RC;
  const ep = sim.link.ports.EP;
  const items = LTSSM_TOP.map((s) => {
    const active = rc.top === s.key;
    return `<li class="${active ? 'active' : ''}" data-state="${s.key}"
      title="单击查看定义、进入/退出条件与物理意义">
      <span class="dot"></span>
      <span class="name">${s.key}<em>${esc(s.cn)}</em></span>
    </li>`;
  }).join('');

  el.innerHTML = `
    <div class="ltssm-ports">
      <div><span>RC</span><code>${esc(rc.state)}</code></div>
      <div><span>EP</span><code>${esc(ep.state)}</code></div>
    </div>
    <ul class="ltssm-list">${items}</ul>
    <p class="hint">单击状态查看定义、进入/退出条件与物理意义。</p>`;
}

export function renderCounters(el, sim) {
  if (sim.fc && sim.fc.enabled) {
    const s = sim.fc.snapshot();
    const rows = FC_CLASSES.map((cls) => `<tr>
      <th>${FC_LABELS[cls]}</th>
      <td>${s.available.RC[cls]} / ${s.limits.RC[cls]}</td>
      <td>${s.available.EP[cls]} / ${s.limits.EP[cls]}</td>
    </tr>`).join('');
    el.innerHTML = `<div class="fc-status ${s.initDone ? 'ok' : 'pending'}">
      ${s.initDone ? 'InitFC 完成' : 'InitFC 进行中'} · Data 信用单位 16B
    </div>
    <table class="ctr fc-table">
      <thead><tr><th>信用</th><th>RC→EP</th><th>EP→RC</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
    return;
  }

  const p = sim.link.ports;
  const row = (label, fn) => `<tr><th>${esc(label)}</th><td>${fn(p.RC)}</td><td>${fn(p.EP)}</td></tr>`;
  el.innerHTML = `<table class="ctr">
    <thead><tr><th>项目</th><th>RC</th><th>EP</th></tr></thead>
    <tbody>
      ${row('TS1 发送', (x) => x.counters.ts1)}
      ${row('TS2 发送', (x) => x.counters.ts2)}
      ${row('SKP 发送', (x) => x.counters.skp)}
      ${row('N_FTS', (x) => x.nFts)}
      ${row('工作速率', (x) => `G${x.rateGen} · ${RATE_BY_GEN[x.rateGen] ?? '-'}`)}
      ${row('数据流模式', () => (sim.link.flitMode ? 'Flit' : 'Non-Flit'))}
      ${row('Lane 数', (x) => x.laneNumbers.length || sim.link.width)}
    </tbody>
  </table>`;
}

function fmtSize(n) {
  if (n >= 0x100000) return `${n / 0x100000} MB`;
  if (n >= 0x400) return `${n / 0x400} KB`;
  return `${n} B`;
}

export function renderConfig(el, sim) {
  const c = sim.config;
  if (!c) {
    el.innerHTML = '<p class="empty">无配置空间模型</p>';
    return;
  }
  const s = c.snapshot();
  const h4 = (v) => '0x' + v.toString(16).toUpperCase().padStart(4, '0');
  const kv = [
    ['Vendor / Device', `${h4(s.vendorId)} / ${h4(s.deviceId)}`],
    ['Class', s.classText],
    ['Header Type', `Type ${s.headerType}`],
    ['Command', `${h4(s.command)}${s.memoryEnabled ? ' · Mem ON' : ''}`],
  ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

  const bars = s.bars.map((b) => `<tr>
    <td>BAR${b.index}${b.is64 ? `/${b.index + 1}` : ''}</td>
    <td>${b.is64 ? '64bit' : '32bit'}</td>
    <td>${fmtSize(b.size)}</td>
    <td class="mono">${b.sizing ? '探测中' : b.base}</td>
  </tr>`).join('');

  el.innerHTML = `<dl class="kv">${kv}</dl>
    <table class="bars">
      <thead><tr><th>BAR</th><th>类型</th><th>大小</th><th>基址</th></tr></thead>
      <tbody>${bars}</tbody>
    </table>`;
}

export function renderPhy(el, sim, collapsed = false) {
  const phy = sim.phy;
  if (!phy) {
    el.innerHTML = '';
    return;
  }
  const s = phy.snapshot();
  const eqText = s.gen >= 3
    ? (s.eq.phase ? `Phase ${s.eq.phase} · ${s.eq.name}` : '待均衡')
    : '不适用（Gen1/2）';
  const rows = [
    ['REF CLK', `${s.refClk.freqMHz} MHz · ${s.refClk.ppm >= 0 ? '+' : ''}${s.refClk.ppm} ppm · ${s.refClk.ssc ? 'SSC' : '无SSC'}`],
    ['PLL', s.pll.locked ? `锁定 · ${s.pll.freqGHz.toFixed(1)} GHz` : '未锁定'],
    ['CDR', cdrText(s.cdr.state)],
    ['EQ', eqText],
    ['COM', `${s.metrics.comDb.toFixed(1)} dB · ${s.metrics.comPass ? 'PASS' : 'FAIL'}`,
      s.metrics.comPass ? 'good' : 'bad'],
    ['眼图', s.metrics.pam4
      ? `PAM4 三 eye · 单眼 ${s.metrics.eyeHeightPerEyeMv.toFixed(0)} mV / ${s.metrics.eyeWidthPs.toFixed(0)} ps`
      : `${s.metrics.eyeHeightMv.toFixed(0)} mV / ${s.metrics.eyeWidthPs.toFixed(0)} ps`],
    ['BER', formatBer(s.metrics.ber)],
  ];
  const b = sim.bert ? sim.bert.snapshot() : null;
  if (b && b.enabled) {
    const lb = sim.loopback ? sim.loopback.snapshot() : null;
    if (lb && lb.mode !== 'none') rows.push(['Loopback', loopbackLabel(lb.mode, lb.channelLossDb)]);
    rows.push(['BERT', `${b.pattern} · ${b.locked ? 'LOCK' : '未锁定'}`, b.locked ? '' : 'bad']);
    const upper = Number.isFinite(b.berUpper) ? b.berUpper.toExponential(1) : '—';
    rows.push(['BERT 判定', `${b.errors} err / ${formatBits(b.bits)} · 95% 上界 ${upper} · ${b.verdict}`,
      b.verdict === 'PASS' ? 'good' : 'bad']);
  }
  const shown = collapsed ? rows.slice(0, 4) : rows;
  const eye = collapsed
    ? ''
    : `<div class="eye-mini">${eyeSvg(s.metrics, { width: 260, height: 84 })}</div>`;
  el.innerHTML = `<dl class="kv phy-kv">${shown.map(([k, v, cls]) => (
    `<div><dt>${esc(k)}</dt><dd class="${cls || ''}">${esc(v)}</dd></div>`
  )).join('')}</dl>${eye}`;
}

export function renderIrq(el, sim) {
  const m = sim.msi.snapshot();
  const a = sim.aer.snapshot();
  const d = sim.dpc.snapshot();
  const rows = [
    ['MSI', m.msiEnabled ? `使能 · ${m.vectorCount} vec` : '关闭'],
    ['MSI-X', m.msixEnabled ? `使能 · ${m.msixTable.length} 项` : '关闭'],
    ['最近向量', m.lastVector === null ? '-' : `#${m.lastVector}`],
    ['中断', `${m.interrupts.length} 次 · 屏蔽/待补发 ${m.suppressed}`],
    ['MSI-X Pending', `${m.pending} 项${m.pendingDelivered ? ` · 已补发 ${m.pendingDelivered}` : '（解除屏蔽后补发）'}`],
    ['AER', a.enabled ? `C ${a.correctable} / NF ${a.nonfatal} / F ${a.fatal} · 消息 ${a.messages}` : '关闭'],
    ['AER Mask', `${a.masked} 条消息被抑制（错误仍计数）`],
    ['最近错误', a.log.length ? a.log[a.log.length - 1].message : '-'],
  ];
  if (d.enabled) {
    rows.push(['DPC', `${d.state}${d.reason ? ` · ${d.reason}` : ''}`]);
    rows.push(['RP PIO', `${d.urCompletions} UR · Posted 丢弃 ${d.postedDropped} · 阻止 ${d.blocked} TLP`]);
  }
  el.innerHTML = `<dl class="kv phy-kv">${rows.map(([k, v]) => (
    `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`
  )).join('')}</dl>`;
}

export function renderAts(el, sim) {
  const a = sim.ats.snapshot();
  const rows = [
    ['ATS', a.enabled ? `使能 · STU ${a.stu / 1024} KB` : '关闭'],
    ['ATC', `${a.cache.length} 项 · 命中 ${a.hits} / 未命中 ${a.misses}`],
    ['翻译请求', `${a.requests} 次 · 完成 ${a.completions}`],
    ['非法请求', `${a.invalidRequests}（Invalid Request / UR）`],
    ['Invalidate', `${a.invalidations} 次（ITag 更新）`],
    ['PRI', a.priEnabled ? `使能 · PRG ${a.prgIndex}` : '关闭'],
    ['Page Request', `${a.pageRequests} 次 · PRG 响应 ${a.prgResponses}`],
  ];
  const kv = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  const entries = a.cache.length
    ? `<table class="ctr"><thead><tr><th>VA</th><th>PA</th><th>粒度</th></tr></thead><tbody>${a.cache
      .map((e) => `<tr><td class="mono">0x${e.va.toString(16).toUpperCase()}</td>
        <td class="mono">0x${e.pa.toString(16).toUpperCase()}</td><td>${e.size / 1024} KB</td></tr>`)
      .join('')}</tbody></table>`
    : '<p class="empty">ATC 为空</p>';
  el.innerHTML = `<dl class="kv phy-kv">${kv}</dl>${entries}`;
}

export function renderPm(el, sim) {
  const p = sim.pm.snapshot();
  const rows = [
    ['D 状态', p.dstate === 'D0' ? `D0 · ${p.pstateName}` : p.dstate],
    ['功耗', `${p.powerW.toFixed(1)} W`],
    ['PMCSR', `0x${p.pmcsr.toString(16).toUpperCase().padStart(4, '0')}`],
    ['PME', p.pmeEn ? (p.pmeStatus ? '已挂起' : '使能') : '关闭'],
    ['链路', p.linkState],
    ['L1 子状态', sim.link.ports.RC.state.startsWith('L1') ? p.l1Sub : '—'],
    ['AUX 电源', p.auxPower ? '有' : '无'],
  ];
  if (sim.hotplug && sim.hotplug.enabled) {
    const h = sim.hotplug.snapshot();
    rows.push(['热插拔', `${h.presence === 'present' ? '在位' : '空槽'} · 槽位电源 ${h.powerController}`]);
    rows.push(['PRSNT#', h.presence === 'present' ? '0（在位）' : '1（空槽）']);
    rows.push(['PERST#', h.perst ? '有效（复位中）' : '释放']);
    rows.push(['电源指示', h.powerIndicator]);
    rows.push(['热插拔中断', `${h.interrupts} 次${h.dllsc ? ' · DLLSC' : ''}`]);
  }
  el.innerHTML = `<dl class="kv phy-kv">${rows.map(([k, v]) => (
    `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`
  )).join('')}</dl>`;
}

export function renderFlit(el, sim) {
  const f = sim.flit.snapshot();
  const rows = [
    ['最近 Flit', f.lastSeq === null ? '-' : `#${f.lastSeq}`],
    ['FEC 纠正', String(f.corrected)],
    ['FEC 不可纠', String(f.uncorrectable)],
    ['Flit 重传', String(f.retries)],
    ['CRC 失败', String(f.crcFails)],
    ['最近状态', f.status],
  ];
  el.innerHTML = `<dl class="kv phy-kv">${rows.map(([k, v]) => (
    `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`
  )).join('')}</dl>`;
}

export function renderLog(el, sim, selectedId) {
  const items = sim.events.slice().reverse();
  el.innerHTML = items.map((ev) => `<li data-id="${ev.id}" class="${ev.id === selectedId ? 'sel' : ''}" title="${esc(ev.summary)}">
    <span class="t">${us(ev.t_ns)} µs</span>
    <span class="ty ty-${ev.layer.toLowerCase()}">${esc(ev.type)}</span>
    <span class="s">${esc(ev.summary)}</span>
  </li>`).join('');
}

function fieldsTable(fields) {
  const rows = fields.map((f) => `<tr>
    <td class="fname">${esc(f.name)}</td>
    <td class="fval">${esc(f.display ?? f.value)}</td>
    <td class="fdesc">${esc(f.desc ?? '')}</td>
  </tr>`).join('');
  return `<table class="fields">
    <thead><tr><th>字段</th><th>当前值</th><th>说明</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function fieldPacketView(packet) {
  const bytes = packet.bytes.map((b, i) => (
    `<span class="byte" title="Byte ${i}">${hex2(b)}</span>`
  )).join('');
  return `
    <div class="insp-section">
      <h3>报文字节</h3>
      <div class="hexrow">${bytes}</div>
    </div>
    <div class="insp-section">
      <h3>字段</h3>
      ${fieldsTable(packet.fields)}
    </div>`;
}

function flitView(packet) {
  const segRows = packet.segments.map((s) => `<tr>
    <td>${esc(s.name)}</td>
    <td>${s.offset}</td>
    <td>${s.length} B</td>
    <td class="sym-desc">${esc(s.desc)}</td>
  </tr>`).join('');
  const bar = packet.segments.map((s) => {
    const cls = s.name === 'TLP 区域' ? 'seg-tlp'
      : s.name === 'DLP' ? 'seg-dlp'
        : s.name === 'CRC' ? 'seg-crc' : 'seg-fec';
    return `<span class="seg ${cls}" style="flex:${s.length}" title="${esc(s.name)} ${s.length}B">${s.length > 20 ? esc(s.name) : ''}</span>`;
  }).join('');

  const check = packet.check || { fec: 'OK', crc: 'OK', retry: false };
  const fecText = check.fec === 'CORRECTED' ? '已纠正' : (check.fec === 'FAIL' ? '不可纠' : 'OK');
  const fecCls = check.fec === 'CORRECTED' ? 'corrected' : (check.fec === 'FAIL' ? 'fail' : 'ok');
  const kv = [
    ['Flit 序号', `#${packet.seq}`],
    ['TLP 数', String(packet.packed.length)],
    ['已用 / 填充', `${packet.payloadBytes}B / ${packet.padding}B`],
    ['FEC 预设结果', fecText],
    ['CRC 预设结果', check.crc],
    ['Flit 重传', check.retry ? '需要' : '否'],
    ['编码', encodingOf(packet.gen)],
  ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

  const tlpRows = packet.packed.length
    ? packet.packed.map((t) => `<tr>
        <td>${esc(t.name)}</td><td>${t.offset}</td><td>${t.length} B</td>
        <td class="sym-desc">${esc(t.summary)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4">IDLE：无 TLP</td></tr>';

  const fecGroups = [0, 1, 2].map((g) => `<span class="fec-group ${fecCls}">G${g} · ${fecText}</span>`).join('');
  const hex = packet.bytes.slice(0, 48).map((b, i) => (
    `<span class="byte" title="Byte ${i}">${hex2(b)}</span>`
  )).join('');

  return `
    <div class="insp-section">
      <dl class="kv">${kv}</dl>
    </div>
    <div class="insp-section">
      <p class="hint">${esc(packet.modelNote || '布局/故障示意，未执行标准校验')}</p>
      <h3>TLP 打包示意</h3>
      <div class="table-scroll">
        <table class="symbols">
          <colgroup><col style="width:86px"><col style="width:58px"><col style="width:60px"><col></colgroup>
          <thead><tr><th>TLP</th><th>偏移</th><th>长度</th><th>摘要</th></tr></thead>
          <tbody>${tlpRows}</tbody>
        </table>
      </div>
      <p class="hint">Flit 内无 STP/END。本图按预设列表展示，使用 NFM TLP 头占位，DLP 数量字段不是标准位域。</p>
    </div>
    <div class="insp-section">
      <h3>256B Flit 分段</h3>
      <div class="flit-bar">${bar}</div>
      <div class="table-scroll">
        <table class="symbols segments">
          <colgroup>
            <col style="width:88px"><col style="width:52px"><col style="width:56px"><col>
          </colgroup>
          <thead><tr><th>区域</th><th>偏移</th><th>长度</th><th>说明</th></tr></thead>
          <tbody>${segRows}</tbody>
        </table>
      </div>
      <div class="fec-groups">${fecGroups}</div>
      <p class="hint">FEC 为三路交织的符号级纠错；接收侧先 FEC 后 CRC。当前仅展示预设故障结果，不执行真实 CRC/FEC；Non-Flit 以 TLP 为重传单位。</p>
    </div>
    <div class="insp-section">
      <h3>前 48 字节（示意，非线上编码）</h3>
      <div class="hexrow">${hex}</div>
    </div>`;
}

function tlpView(packet) {
  const bytes = packet.bytes.map((b, i) => (
    `<span class="byte" title="Byte ${i}">${hex2(b)}</span>`
  )).join('');
  const dataHex = packet.dataDws.length
    ? `<div class="insp-section">
        <h3>数据（DW）</h3>
        <div class="hexrow">${packet.dataDws.map((dw) => `<span class="byte">0x${(dw >>> 0).toString(16).toUpperCase().padStart(8, '0')}</span>`).join('')}</div>
      </div>`
    : '';
  return `<p class="hint">逻辑 DWORD 顺序，DWORD 内小端字节；非线上抓包字节流。${packet.fidelity === 'schematic' ? '本消息为示意，未实现标准完整头。' : 'Non-Flit 字段模型（选定子集）'}</p>
    <div class="insp-section">
      <h3>TLP 字节（${packet.headerLen}B 头 + ${packet.dataBytes.length}B 数据）</h3>
      <div class="hexrow">${bytes}</div>
    </div>
    <div class="insp-section">
      <h3>字段</h3>
      ${fieldsTable(packet.fields)}
    </div>
    ${dataHex}`;
}

function packetView(packet) {
  if (packet.kind === 'FLIT') return flitView(packet);
  if (packet.kind === 'TLP') return tlpView(packet);
  if (packet.kind === 'DLLP' || packet.kind === 'MSG') return fieldPacketView(packet);

  const symbols = (packet.symbolTable || []).map((s) => `<tr class="sym-${s.cat}">
    <td class="sym-idx">${s.index}</td>
    <td class="sym-hex">${hex2(s.value)}</td>
    <td class="sym-name">${esc(s.name)}</td>
    <td class="sym-desc">${esc(s.desc)}</td>
  </tr>`).join('');

  const bytes = packet.bytes.map((b, i) => (
    `<span class="byte" title="Symbol ${i}">${hex2(b)}</span>`
  )).join('');

  const laneRate = ratesCompact(packet.rates);
  const lanes = (packet.lanes || []).map((l) => `<tr>
    <td>${l.lane}</td>
    <td>${l.number === null ? 'PAD' : l.number}</td>
    <td>${l.link === null ? 'PAD' : l.link}</td>
    <td>${packet.nFts}</td>
    <td class="c-rate" title="${esc(ratesText(packet.rates))}">${esc(laneRate)}</td>
    <td>${packet.speedChange ? '1' : '0'}</td>
  </tr>`).join('');

  return `
    <div class="insp-section">
      <h3>有序集字节（16 符号）</h3>
      <div class="hexrow">${bytes}</div>
      <p class="hint">逻辑视图：同一有序集在全部 Lane 上并行发送，Lane 0 的符号列在此展示。</p>
    </div>
    <div class="insp-section">
      <h3>符号编码明细（Lane 0）</h3>
      <div class="table-scroll tall">
        <table class="symbols">
          <colgroup>
            <col style="width:36px">
            <col style="width:58px">
            <col style="width:164px">
            <col>
          </colgroup>
          <thead><tr><th>#</th><th>编码</th><th>字段</th><th>定义 / 含义</th></tr></thead>
          <tbody>${symbols}</tbody>
        </table>
      </div>
      <p class="hint">其余 Lane 除 Symbol 2（Lane Number）外与 Lane 0 相同；4Ah/45h 为 Gen1/2 的 D10.2/D5.2 标识符。</p>
    </div>
    <div class="insp-section">
      <h3>Lane 矩阵</h3>
      <div class="table-scroll">
        <table class="lanes">
          <colgroup>
            <col style="width:52px">
            <col style="width:68px">
            <col style="width:68px">
            <col style="width:60px">
            <col style="width:126px">
            <col style="width:66px">
          </colgroup>
          <thead><tr><th>Lane</th><th>Lane Num</th><th>Link Num</th><th>N_FTS</th><th>支持速率</th><th>Speed Chg</th></tr></thead>
          <tbody>${lanes}</tbody>
        </table>
      </div>
    </div>`;
}

export function inspectorHtml(sim, selectedId) {
  const ev = selectedId === null ? null : sim.events.find((e) => e.id === selectedId);
  if (!ev) {
    return '<p class="empty">点击时间轴或事件日志中的事件，查看有序集字段、字节与 Lane 级信息。</p>';
  }
  const phase = sim.phases.find((p) => p.key === ev.phase);
  const meta = [
    ['时间', `${us(ev.t_ns)} µs`],
    ['阶段', phase ? phase.label : '-'],
    ['层', ev.layer],
    ['方向', ev.dir],
    ['状态', ev.status],
  ];

  const interp = interpretEvent(ev);
  const packetMeaning = ev.packet && ev.packet.summary
    ? `<div class="insp-section">
        <h3>报文含义</h3>
        <p class="event-pkt">${esc(ev.packet.summary)}</p>
      </div>`
    : '';

  return `
    <div class="insp-head">
      <span class="badge b-${esc(ev.type.toLowerCase())}">${esc(ev.type)}</span>
      <div class="insp-title">${esc(ev.summary)}</div>
    </div>
    <div class="insp-meta">${meta
    .map(([k, v]) => `<span><em>${esc(k)}</em>${esc(v)}</span>`).join('')}</div>
    <div class="insp-section event-read">
      <h3>事件解读</h3>
      <div class="event-read-head">
        <b>${esc(interp.title)}</b>
        <span class="event-read-layer">${esc(interp.layerName)}</span>
      </div>
      <p><span class="lbl">物理意义</span>${esc(interp.physics)}</p>
      <p><span class="lbl">协议作用</span>${esc(interp.role)}</p>
      <p><span class="lbl">所属层次</span>${esc(interp.layerPhysics)}</p>
      ${interp.known ? '' : '<p class="hint">该类型暂无专门解读，以上为所属层次的通用说明。</p>'}
    </div>
    ${ev.detail ? `<p class="detail">${esc(ev.detail)}</p>` : ''}
    ${packetMeaning}
    ${ev.packet ? packetView(ev.packet) : '<p class="hint">该事件没有报文载荷。</p>'}`;
}

export function renderInspector(el, sim, selectedId) {
  el.innerHTML = inspectorHtml(sim, selectedId);
}
