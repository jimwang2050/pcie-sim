import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOrderedSet, decodeOrderedSet, orderedSetTimeNs, ratesBitmap, PAD,
} from '../js/core/packet.js';
import { buildFlit, checkFlit, flitTimeNs } from '../js/core/flit.js';
import { LTSSM_INFO } from '../js/core/ltssm_info.js';
import { playbackTiming } from '../js/core/playback.js';
import { buildCfg, buildCpl, buildMem, bdfText } from '../js/core/tlp.js';
import { ConfigSpace } from '../js/core/config.js';
import { PhyModel, EQ_PRESETS } from '../js/core/phy.js';
import { BertModel, formatBits, BERT_PATTERNS, BERT_PATTERN_ORDER } from '../js/core/bert.js';
import { FlowControl } from '../js/core/fc.js';
import { Memory } from '../js/core/memory.js';
import { MsiModel } from '../js/core/msi.js';
import { AerModel } from '../js/core/aer.js';
import { PmModel } from '../js/core/pm.js';
import { Sim } from '../js/core/sim.js';
import { buildLinkTraining } from '../js/scenarios/link_training.js';
import { buildLtssmPm } from '../js/scenarios/ltssm_pm.js';
import { buildPhyLink } from '../js/scenarios/phy_link.js';
import { buildLoopbackBert } from '../js/scenarios/loopback_bert.js';
import { buildMemRead } from '../js/scenarios/mem_read.js';
import { buildMemWrite } from '../js/scenarios/mem_write.js';
import { buildMsiInt } from '../js/scenarios/msi_int.js';
import { buildAerError } from '../js/scenarios/aer_error.js';
import { buildDpcRpio } from '../js/scenarios/dpc_rpio.js';
import { buildAts } from '../js/scenarios/ats.js';
import { buildPmDp } from '../js/scenarios/pm_dp.js';
import { buildFlitGen6 } from '../js/scenarios/flit_gen6.js';
import { buildEnumeration } from '../js/scenarios/enumeration.js';
import { interpretEvent } from '../js/core/event_info.js';
import { inspectorHtml } from '../js/ui/panels.js';
import { pmModel, archInfo } from '../js/ui/models.js';

test('TS1 有序集编解码往返一致', () => {
  const pkt = buildOrderedSet('TS1', { gen: 3, width: 8, nFts: 12, laneNumbers: [0, 1, 2, 3, 4, 5, 6, 7] });
  assert.equal(pkt.bytes.length, 16);
  assert.equal(pkt.lanes.length, 8);
  const dec = decodeOrderedSet(pkt.bytes);
  assert.equal(dec.kind, 'TS1');
  assert.equal(dec.link, 0);
  assert.equal(dec.laneNumber, 0);
  assert.equal(dec.nFts, 12);
  assert.equal(dec.rates, ratesBitmap(3));
  assert.equal(dec.speedChange, false);
  assert.equal(dec.control, 0);
});

test('Data Rate 字段是支持速率位图而非 4bit 速率码', () => {
  const pkt = buildOrderedSet('TS1', { gen: 5, width: 4, rates: ratesBitmap(5) });
  assert.equal(pkt.bytes[4], 0x3e, 'bit1..bit5 全置 1');
  const dec = decodeOrderedSet(pkt.bytes);
  assert.equal(dec.rates, 0x3e);
});

test('Polling 阶段 Link/Lane 字段均为 PAD', () => {
  const pkt = buildOrderedSet('TS1', {
    gen: 3, width: 4, linkPAD: true, laneNumbers: [null, null, null, null],
  });
  assert.equal(pkt.bytes[1], PAD);
  assert.equal(pkt.bytes[2], PAD);
  assert.equal(pkt.linkPAD, true);
  assert.ok(pkt.lanes.every((l) => l.number === null && l.link === null));
});

test('未分配通道发送 PAD', () => {
  const pkt = buildOrderedSet('TS1', { gen: 3, width: 4, laneNumbers: [0, null, null, null] });
  assert.equal(pkt.lanes[0].number, 0);
  assert.equal(pkt.lanes[1].number, null);
  assert.equal(pkt.bytes[2], 0, 'Lane 0 的 Lane Number 字段为 0');
  assert.equal(pkt.lanes[1].symbols[2], PAD);
});

test('有序集提供 16 条逐符号编码与含义', () => {
  const pkt = buildOrderedSet('TS1', { gen: 3, width: 4 });
  assert.equal(pkt.symbolTable.length, 16);
  assert.equal(pkt.symbolTable[0].name, 'OS 标识');
  assert.equal(pkt.symbolTable[1].value, 0);
  assert.equal(pkt.symbolTable[4].value, ratesBitmap(3));
  assert.equal(pkt.symbolTable[10].value, 0x4a);
  assert.equal(pkt.symbolTable[15].value, 0x4a);
  for (const s of pkt.symbolTable) {
    assert.ok(s.name && s.desc, `Symbol ${s.index} 缺少名称或含义`);
  }

  const ts2 = buildOrderedSet('TS2', { gen: 3, width: 4 });
  assert.equal(ts2.symbolTable[10].value, 0x45);

  const g1 = buildOrderedSet('TS1', { gen: 1, width: 4 });
  assert.equal(g1.symbolTable[6].value, 0x4a);
  assert.equal(g1.symbolTable[15].value, 0x4a);
});

test('有序集传输时间随速率与宽度下降', () => {
  const g1x1 = orderedSetTimeNs(1, 1);
  const g3x8 = orderedSetTimeNs(3, 8);
  const g5x16 = orderedSetTimeNs(5, 16);
  assert.ok(g1x1 > g3x8);
  assert.ok(g3x8 > g5x16);
  assert.ok(g5x16 > 0);
});

function runScenario(gen, width) {
  const sim = new Sim();
  sim.reset({ gen, width });
  buildLinkTraining(sim, { gen, width });
  sim.runToEnd();
  return sim;
}

test('Gen3 x8：复位后可完整训练到 L0 并完成变速', () => {
  const sim = runScenario(3, 8);
  assert.equal(sim.link.ports.RC.state, 'L0');
  assert.equal(sim.link.ports.EP.state, 'L0');
  assert.equal(sim.link.linkUp, true);
  assert.equal(sim.link.ports.RC.rateGen, 3);
  assert.equal(sim.link.negotiated.gen, 3);
  assert.equal(sim.link.negotiated.width, 8);

  const phases = sim.phases.map((p) => p.key);
  for (const key of ['detect', 'polling', 'config', 'recovery', 'l0']) {
    assert.ok(phases.includes(key), `缺少阶段 ${key}`);
  }

  const types = new Set(sim.events.map((e) => e.type));
  for (const t of ['LTSSM', 'TS1', 'TS2', 'SKP', 'DETECT', 'SPEED']) {
    assert.ok(types.has(t), `缺少事件类型 ${t}`);
  }

  assert.ok(sim.link.ports.RC.counters.ts1 >= 3);
  assert.ok(sim.link.ports.RC.counters.ts2 >= 2);
  assert.ok(sim.link.ports.EP.counters.skp >= 1);
  assert.ok(sim.finished);
});

test('Polling 的 TS1 使用 PAD，RcvrLock 置 Speed Change', () => {
  const sim = runScenario(3, 8);
  const polling = sim.events.find((e) => e.type === 'TS1' && e.phase === 'polling');
  assert.ok(polling, '缺少 Polling TS1');
  assert.equal(polling.packet.linkPAD, true);
  assert.ok(polling.packet.lanes.every((l) => l.number === null));

  const rcvrLock = sim.events.find((e) => e.type === 'TS1' && e.phase === 'recovery');
  assert.ok(rcvrLock, '缺少 Recovery TS1');
  assert.equal(rcvrLock.packet.speedChange, true);
  assert.equal(rcvrLock.packet.link, 0);
});

test('Configuration 阶段逐步分配 Lane Number', () => {
  const sim = runScenario(3, 4);
  const start = sim.events.find((e) => e.type === 'TS1' && /Linkwidth.Start/.test(e.summary));
  assert.ok(start);
  assert.ok(start.packet.lanes.every((l) => l.number === null), 'Linkwidth.Start 阶段 Lane=PAD');

  const lanenum = sim.events.find((e) => e.type === 'TS1' && /Lanenum.Wait/.test(e.summary));
  assert.ok(lanenum);
  assert.deepEqual(lanenum.packet.lanes.map((l) => l.number), [0, 1, 2, 3]);
});

test('Gen1 不需要 Recovery 变速', () => {
  const sim = runScenario(1, 4);
  assert.equal(sim.link.ports.RC.state, 'L0');
  assert.equal(sim.link.ports.RC.rateGen, 1);
  assert.ok(!sim.phases.some((p) => p.key === 'recovery'));
});

test('Gen6 强制 Flit 模式并产生 FLIT 事件', () => {
  const sim = new Sim();
  sim.reset({ gen: 6, width: 8 });
  buildLinkTraining(sim, { gen: 6, width: 8, mode: 'auto' });
  sim.runToEnd();

  assert.equal(sim.link.flitMode, true);
  assert.equal(sim.link.ports.RC.rateGen, 6);
  assert.equal(sim.link.ports.RC.state, 'L0');
  assert.ok(sim.events.some((e) => e.type === 'FLIT'));
  assert.ok(sim.events.some((e) => e.type === 'MODE' && /Flit Mode/.test(e.summary)));

  const ts1 = sim.events.find((e) => e.type === 'TS1' && e.phase === 'polling');
  assert.ok(ts1);
  assert.equal(ts1.packet.flitMode, true);
  assert.equal(ts1.packet.bytes[4] & 0x01, 1, 'Symbol 4 bit0 = Flit Mode Supported');
  assert.equal(ts1.packet.rates, ratesBitmap(6));
});

test('Gen5 可手动选择 Flit 模式做对比', () => {
  const sim = new Sim();
  sim.reset({ gen: 5, width: 4 });
  buildLinkTraining(sim, { gen: 5, width: 4, mode: 'flit' });
  sim.runToEnd();
  assert.equal(sim.link.flitMode, true);
  assert.ok(sim.events.some((e) => e.type === 'FLIT'));
  assert.equal(sim.link.ports.RC.rateGen, 5);
});

test('Gen5 默认 Non-Flit：无 FLIT，保留 SKP', () => {
  const sim = new Sim();
  sim.reset({ gen: 5, width: 4 });
  buildLinkTraining(sim, { gen: 5, width: 4, mode: 'auto' });
  sim.runToEnd();
  assert.equal(sim.link.flitMode, false);
  assert.ok(!sim.events.some((e) => e.type === 'FLIT'));
  assert.ok(sim.events.some((e) => e.type === 'SKP'));
});

test('Flit 模型：256B 分段与序号', () => {
  const f = buildFlit({ seq: 3, gen: 6, width: 8 });
  assert.equal(f.bytes.length, 256);
  assert.equal(f.segments.reduce((a, s) => a + s.length, 0), 256);
  assert.equal(f.seq, 3);
  assert.equal(f.bytes[236], 3);
  assert.equal(f.bytes[237], 0);
  assert.ok(flitTimeNs(6, 8) > 0);
});

test('LTSSM PM 场景覆盖 L0s / L1 子状态 / L2 唤醒', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  const info = buildLtssmPm(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  // Beacon 唤醒后回到 L0；随后热插拔演示以拔出（空槽）结束
  assert.ok(sim.events.some((e) => (e.summary || '').includes('唤醒完成，回到 L0')), '缺少 Beacon 唤醒回到 L0');
  assert.equal(sim.link.ports.RC.state, 'Detect.Quiet', '拔出后链路断开');
  assert.equal(sim.pm.snapshot().l1Sub, 'L1.2');
  assert.equal(info.rows.length, 5);

  const phases = sim.phases.map((p) => p.key);
  for (const key of ['l0', 'l0s', 'l1_req', 'l1', 'l1_wake', 'l1_exit', 'l0b',
    'l2_req', 'l2', 'l2_wake', 'l2_retrain', 'pm_summary',
    'hp_insert', 'hp_attention', 'hp_remove', 'hp_summary']) {
    assert.ok(phases.includes(key), `缺少阶段 ${key}`);
  }

  const types = new Set(sim.events.map((e) => e.type));
  for (const t of ['DLLP', 'MSG', 'EIOS', 'FTS', 'TS1', 'TS2', 'PM']) {
    assert.ok(types.has(t), `缺少事件类型 ${t}`);
  }
  assert.ok(sim.events.some((e) => e.packet && e.packet.kind === 'DLLP'));
  assert.ok(sim.events.some((e) => e.packet && e.packet.kind === 'MSG'));

  // L1.1 / L1.2 子状态与 CLKREQ# / Beacon 唤醒事件
  const states = sim.events.filter((e) => e.layer === 'STATE').map((e) => e.summary);
  assert.ok(states.some((s) => s.includes('L1.1')), '缺少 L1.1 子状态');
  assert.ok(states.some((s) => s.includes('L1.2')), '缺少 L1.2 子状态');
  const pmText = sim.events.filter((e) => e.type === 'PM').map((e) => e.summary).join(' | ');
  assert.ok(pmText.includes('CLKREQ#'), '缺少 CLKREQ# 唤醒');
  assert.ok(pmText.includes('Beacon'), '缺少 Beacon 唤醒');
  assert.ok(pmText.includes('WAKE#'), '缺少 WAKE# 替代路径');
  assert.ok(pmText.includes('PM_PME'), '缺少唤醒机制总结');

  // 热插拔：插入上电 → DLLSC / 中断 → Attention → 拔出断电
  const h = sim.hotplug.snapshot();
  assert.equal(h.enabled, true);
  assert.equal(h.presence, 'absent');
  assert.equal(h.powerController, 'off');
  assert.equal(h.inserts, 1);
  assert.equal(h.removals, 1);
  assert.equal(h.interrupts, 3);
  assert.ok(pmText.includes('PRSNT#'), '缺少 PRSNT# 插拔检测');
  assert.ok(pmText.includes('DLLSC'), '缺少 DLLSC 事件');
  assert.ok(pmText.includes('Attention'), '缺少 Attention Button');
  assert.ok(pmText.includes('PERST#'), '缺少 PERST# 释放');
});

test('DPC + RP PIO 场景：触发、隔离、UR Completion 与恢复', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildDpcRpio(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  const phases = sim.phases.map((p) => p.key);
  for (const key of ['dpc_cfg', 'dpc_normal', 'dpc_trigger', 'dpc_contain', 'dpc_recover']) {
    assert.ok(phases.includes(key), `缺少阶段 ${key}`);
  }

  const d = sim.dpc.snapshot();
  assert.equal(d.enabled, true);
  assert.equal(d.reason, '');
  assert.equal(d.urCompletions, 1);
  assert.equal(d.blocked, 1);
  assert.equal(d.interrupts, 1);

  const summaries = sim.events.map((e) => e.summary || '');
  assert.ok(summaries.some((s) => s.includes('DPC 触发')), '缺少 DPC 触发事件');
  assert.ok(summaries.some((s) => s.includes('UR Completion')), '缺少 RP PIO UR Completion');
  assert.ok(summaries.some((s) => s.includes('Egress Control')), '缺少 Egress Control');
  assert.equal(sim.link.ports.RC.state, 'L0');
});

test('ATS + PRI 场景：翻译、ATC 命中、Invalid Request、Invalidate 与缺页', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildAts(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  const phases = sim.phases.map((p) => p.key);
  for (const key of ['ats_cfg', 'ats_miss', 'ats_hit', 'ats_invalid', 'ats_inval', 'page_request', 'ats_done']) {
    assert.ok(phases.includes(key), `缺少阶段 ${key}`);
  }

  const a = sim.ats.snapshot();
  assert.equal(a.enabled, true);
  assert.equal(a.priEnabled, true);
  assert.equal(a.stu, 4096);
  assert.equal(a.requests, 3);
  assert.equal(a.completions, 2);
  assert.equal(a.hits, 1);
  assert.equal(a.invalidRequests, 1);
  assert.equal(a.invalidations, 1);
  assert.equal(a.pageRequests, 1);
  assert.equal(a.prgResponses, 1);
  assert.equal(a.cache.length, 1, 'VA1 已被 Invalidate 清除，仅保留 VA2');

  const tr = sim.events.find((e) => e.type === 'TR');
  assert.ok(tr && tr.packet.at === 1, 'Translation Request 应使用 AT=01b');
  const tc = sim.events.filter((e) => e.type === 'TC' && e.packet.status === 1);
  assert.ok(tc.length >= 1, '缺少 Invalid Request 的 UR Completion');

  const summaries = sim.events.map((e) => e.summary || '');
  for (const text of ['Translation Request', 'Invalid Request', 'Invalidate Request', 'Page Request', 'PRG Response']) {
    assert.ok(summaries.some((s) => s.includes(text)), `缺少事件：${text}`);
  }
});

test('事件解读：详情面板包含物理意义与协议作用', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildLinkTraining(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  const ev = sim.events.find((e) => e.type === 'TS1') || sim.events[0];
  const html = inspectorHtml(sim, ev.id);
  assert.ok(html.includes('事件解读'), '缺少事件解读区块');
  assert.ok(html.includes('物理意义'), '缺少物理意义');
  assert.ok(html.includes('协议作用'), '缺少协议作用');

  const info = interpretEvent({ type: 'TS1', layer: 'PHY' });
  assert.equal(info.known, true);
  assert.equal(info.title, 'TS1 有序集');
  assert.ok(info.physics.includes('位锁'));

  const fallback = interpretEvent({ type: '未知类型', layer: 'TL' });
  assert.equal(fallback.known, false);
  assert.ok(fallback.physics.includes('事务层'), '未知类型应回退到层次说明');
});

test('PM 典型模型：L / D / P 状态、三层架构与唤醒机制', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildLtssmPm(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  const html = pmModel({
    pm: sim.pm.snapshot(),
    link: sim.link.snapshot(),
    hotplug: sim.hotplug.snapshot(),
    phy: sim.phy.snapshot(),
  });
  for (const text of ['L0s', 'L0p', 'L1.1', 'L1.2', 'L2', 'L3', 'D3hot', 'D3cold',
    'P0', 'P1', 'P2', 'CLKREQ#', 'Beacon', 'WAKE#', 'PM_PME', 'FTS',
    '平台 / ACPI', 'RP 控制器', 'RP PHY', 'Slot / 连接器', 'EP PHY', 'EP 控制器', '金手指',
    'REF CLK 100 MHz', 'REF CLK → RP PHY', 'CLKREQ# / WAKE#',
    'REF CLK 门控', '点击展开']) {
    assert.ok(html.includes(text), `PM 模型缺少 ${text}`);
  }
  assert.ok(html.includes('L 状态') && html.includes('D 状态'), '缺少 L/D 状态表');

  // REF CLK / CLKREQ# 是架构中的可点击机制
  assert.ok(archInfo('pm', 'refclk', sim.phy.snapshot(), sim), '缺少 REF CLK 机制');
  assert.ok(archInfo('pm', 'clkreq', sim.phy.snapshot(), sim), '缺少 CLKREQ# 机制');
  const gate = archInfo('pm', 'clkgate', sim.phy.snapshot(), sim);
  assert.ok(gate && gate.formula.some((f) => f.includes('CLKREQ#')), '缺少 CLKREQ# 门控浮窗');
  // 门控细节折叠进浮窗：图上只留入口，细节在浮窗的示意图与条目中
  const gateText = [...gate.formula, gate.figure].join(' ');
  for (const t of ['RP CLKREQ#', 'EP CLKREQ#', '时钟门控', 'REF CLK EN', 'R_pu 上拉', 'Vaux 3.3V']) {
    assert.ok(gateText.includes(t), `门控浮窗缺少 ${t}`);
  }

  // 交互模型：四个场景可切换，各自包含真实握手报文
  for (const scn of ['l0s', 'l1', 'l2', 'hp']) {
    assert.ok(html.includes(`data-pm-scn="${scn}"`), `缺少交互场景 ${scn}`);
  }
  const l2 = pmModel({
    pm: sim.pm.snapshot(),
    link: sim.link.snapshot(),
    hotplug: sim.hotplug.snapshot(),
    phy: sim.phy.snapshot(),
  }, 'l2');
  for (const text of ['PME_Turn_Off', 'PME_TO_Ack', 'PM_Enter_L23', 'Beacon', 'PERST#']) {
    assert.ok(l2.includes(text), `L2 交互缺少 ${text}`);
  }
  const hp = pmModel({
    pm: sim.pm.snapshot(),
    link: sim.link.snapshot(),
    hotplug: sim.hotplug.snapshot(),
    phy: sim.phy.snapshot(),
  }, 'hp');
  for (const text of ['PRSNT#', 'DLLSC', 'Attention Button']) {
    assert.ok(hp.includes(text), `热插拔交互缺少 ${text}`);
  }
  assert.ok(html.includes('握手约束'), '缺少握手约束');
  assert.ok(html.includes('信号交互'), '缺少信号交互表');

  const info = archInfo('pm', 'wake', sim.phy.snapshot(), sim);
  assert.ok(info && info.formula.length > 0, 'PM 架构方块缺少说明');
  assert.equal(archInfo('pm', 'not-exist', sim.phy.snapshot(), sim), null);
});

test('LTSSM 状态说明覆盖 11 个顶层状态', () => {
  assert.equal(LTSSM_INFO.length, 11);
  const keys = LTSSM_INFO.map((s) => s.key);
  for (const key of ['Detect', 'Polling', 'Configuration', 'L0', 'Recovery',
    'L0s', 'L1', 'L2', 'Hot Reset', 'Loopback', 'Disable']) {
    assert.ok(keys.includes(key), `缺少状态 ${key}`);
  }
  for (const s of LTSSM_INFO) {
    assert.ok(s.definition && s.definition.length > 10, `${s.key} 缺少定义`);
    assert.ok(s.physical && s.physical.length > 10, `${s.key} 缺少物理意义`);
    assert.ok(Array.isArray(s.entry) && s.entry.length > 0, `${s.key} 缺少进入条件`);
    assert.ok(Array.isArray(s.exit) && s.exit.length > 0, `${s.key} 缺少退出条件`);
    assert.ok(Array.isArray(s.substates), `${s.key} 子状态格式错误`);
  }
});

test('播放速度换算：慢放拉长间隔，加速每 tick 多步', () => {
  assert.deepEqual(playbackTiming(0.03125), { interval: 2240, batch: 1 });
  assert.deepEqual(playbackTiming(0.0625), { interval: 1120, batch: 1 });
  assert.deepEqual(playbackTiming(0.125), { interval: 560, batch: 1 });
  assert.deepEqual(playbackTiming(0.25), { interval: 280, batch: 1 });
  assert.deepEqual(playbackTiming(0.5), { interval: 140, batch: 1 });
  assert.deepEqual(playbackTiming(1), { interval: 70, batch: 1 });
  assert.deepEqual(playbackTiming(2), { interval: 70, batch: 2 });
  assert.deepEqual(playbackTiming(4), { interval: 70, batch: 4 });
});

test('TLP：CfgRd0 / CfgWr0 / CplD 编解码', () => {
  const req = buildCfg({ write: false, bdf: 0x0100, reg: 0x10, requester: 0, tag: 3 });
  assert.equal(req.kind, 'TLP');
  assert.equal(req.name, 'CfgRd0');
  assert.equal(req.headerLen, 12);
  assert.equal(req.bytes.length, 12);
  assert.equal(req.bdf, 0x0100);
  assert.equal(req.reg, 0x10);
  assert.equal(req.tag, 3);
  assert.equal(bdfText(0x0100), '01:00.0');

  const wr = buildCfg({ write: true, bdf: 0x0100, reg: 0x10, requester: 0, tag: 4, data: 0xffffffff });
  assert.equal(wr.name, 'CfgWr0');
  assert.equal(wr.bytes.length, 16);
  assert.equal(wr.dataDws[0], 0xffffffff);

  const cpl = buildCpl({ requester: 0, completer: 0x0100, tag: 4, dataDws: [0x56781234] });
  assert.equal(cpl.name, 'CplD');
  assert.equal(cpl.dataDws[0], 0x56781234);
  assert.equal(cpl.byteCount, 4);
  assert.equal(cpl.completer, 0x0100);

  const rd64 = buildMem({ write: false, address: 0x80000000, is64: true, lengthDw: 1, tag: 5 });
  assert.equal(rd64.name, 'MRd');
  assert.equal(rd64.address, 0x80000000);
  assert.equal(rd64.headerLen, 16);
});

test('配置空间：BAR 探测、64bit 分配与 Memory Enable', () => {
  const c = new ConfigSpace();
  assert.equal(c.read(0x00), 0x56781234);
  assert.equal(c.read(0x0e) & 0xff, 0x00);

  c.write(0x10, 0xffffffff);
  assert.equal(c.read(0x10), 0xfffff000, '4KB BAR 大小掩码');
  assert.equal(c.read(0x14), 0xffffffff, '64bit BAR 高 32 位掩码');
  c.write(0x10, 0x80000000);
  c.write(0x14, 0x00000000);
  assert.equal(c.read(0x10), 0x80000000);
  assert.equal(c.baseHex(c.bars[0]), '0x0000000080000000');

  c.write(0x18, 0xffffffff);
  assert.equal(c.read(0x18), 0xffffc000, '16KB BAR 大小掩码');
  c.write(0x18, 0x90000000);
  assert.equal(c.read(0x18), 0x90000000);

  c.write(0x04, 0x0002);
  assert.equal(c.memoryEnabled, true);
});

test('枚举场景：完成 BAR 分配与 Memory Space 使能', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  const info = buildEnumeration(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  assert.equal(sim.link.ports.RC.state, 'L0');
  assert.equal(sim.config.read(0x10), 0x80000000);
  assert.equal(sim.config.read(0x18), 0x90000000);
  assert.equal(sim.config.command & 0x2, 0x2);
  assert.equal(info.rows.length, 5);

  const types = new Set(sim.events.map((e) => e.type));
  for (const t of ['CfgRd0', 'CfgWr0', 'CplD', 'ACK', 'ENUM']) {
    assert.ok(types.has(t), `缺少事件类型 ${t}`);
  }
  const phases = sim.phases.map((p) => p.key);
  for (const k of ['enum-probe', 'enum-bars', 'enum-enable']) {
    assert.ok(phases.includes(k), `缺少阶段 ${k}`);
  }
  assert.ok(sim.events.some((e) => e.packet && e.packet.kind === 'TLP'));
  assert.ok(sim.events.filter((e) => e.type === 'CplD').length >= 9);
  assert.ok(sim.events.filter((e) => e.type === 'ACK').length >= 18);
});

test('PHY 模型：PLL/CDR/EQ 改善 COM、眼图与 BER', () => {
  const p = new PhyModel();
  p.reset(3, 8);
  assert.equal(p.pll.locked, false);
  assert.equal(p.cdr.state, 'UNLOCKED');
  const com0 = p.metrics.comDb;

  p.stabilizeRefClk();
  p.lockPll();
  p.cdrFreqLock();
  p.cdrPhaseLock();
  p.cdrBitLock();
  const com1 = p.metrics.comDb;
  assert.ok(com1 > com0, 'CDR 锁定后 COM 应提高');

  p.setEqPhase(3, 10);
  const com2 = p.metrics.comDb;
  assert.ok(com2 > com1, 'EQ 收敛后 COM 应继续提高');
  assert.equal(p.metrics.comPass, true);
  assert.ok(p.metrics.eyeHeightMv > 300);
  assert.ok(p.metrics.ber < 1e-6);
});

test('PHY 场景：REFCLK → CDR → EQ → L0', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildPhyLink(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  assert.equal(sim.link.ports.RC.state, 'L0');
  assert.equal(sim.link.ports.RC.rateGen, 3);
  assert.equal(sim.phy.metrics.comPass, true);

  const phases = sim.phases.map((p) => p.key);
  for (const k of ['refclk', 'cdr', 'speed', 'eq', 'l0']) {
    assert.ok(phases.includes(k), `缺少阶段 ${k}`);
  }
  const types = new Set(sim.events.map((e) => e.type));
  for (const t of ['REFCLK', 'PLL', 'CDR', 'EQ', 'COM']) {
    assert.ok(types.has(t), `缺少事件类型 ${t}`);
  }
});

test('EQ 预设归一化，预设扫描选择最佳眼开度', () => {
  for (const p of EQ_PRESETS) {
    assert.ok(Math.abs(p.pre + p.cursor + p.post - 1) < 1e-9, `${p.name} 系数未归一化`);
  }

  const p = new PhyModel();
  p.reset(5, 8);
  p.cdrBitLock();
  p.setOperatingRate(5);

  const best = p.bestPreset();
  let maxEye = 0;
  for (let i = 0; i < EQ_PRESETS.length; i += 1) {
    maxEye = Math.max(maxEye, p.eyeForPreset(i));
  }
  assert.ok(Math.abs(p.eyeForPreset(best) - maxEye) < 1e-9, 'bestPreset 未选到最大眼开度');

  const comBefore = p.metrics.comDb;
  p.setEqPhase(3, best);
  assert.ok(p.metrics.comDb > comBefore);
  assert.equal(p.metrics.comPass, true);
  assert.equal(p.eq.converged, true);
});

test('RX CTLE/DFE 改善均衡后眼开度', () => {
  const p = new PhyModel();
  p.reset(4, 8);
  p.cdrBitLock();
  const withRx = p.eyeForPreset(10);
  const ctle = p.rxEq.ctleDb;
  const dfe = p.rxEq.dfeTaps;
  p.rxEq.ctleDb = 0;
  p.rxEq.dfeTaps = 0;
  const withoutRx = p.eyeForPreset(10);
  assert.ok(withRx > withoutRx, 'RX EQ 应改善眼开度');
  p.rxEq.ctleDb = ctle;
  p.rxEq.dfeTaps = dfe;
});

test('PHY 场景 Gen1 无 Equalization', () => {
  const sim = new Sim();
  sim.reset({ gen: 1, width: 4 });
  buildPhyLink(sim, { gen: 1, width: 4 });
  sim.runToEnd();

  assert.equal(sim.link.ports.RC.state, 'L0');
  assert.ok(!sim.phases.some((p) => p.key === 'eq'));
  assert.equal(sim.phy.metrics.comPass, true);
});

test('BERT 模型：锁定、累计、注入与清除', () => {
  const b = new BertModel();
  assert.equal(b.enabled, false);
  b.start('PRBS31');
  assert.equal(b.enabled, true);
  assert.equal(b.pass, false, '未锁定前不应 PASS');

  b.lock();
  b.accumulate(1e9, 0);
  assert.equal(b.ber, 0);
  assert.equal(b.pass, true);

  b.inject(3);
  assert.ok(b.ber > 1e-12);
  assert.equal(b.pass, false);

  b.clear();
  b.accumulate(1e9, 0);
  assert.equal(b.pass, true);
  assert.equal(formatBits(1e9), '1.0 Gb');
  assert.ok(b.injections.some((h) => h.kind === 'inject'));
});

test('Loopback / BERT：Internal 与 External 是两套独立配置', () => {
  // ---- Internal：器件内部回环，链路不受影响 ----
  const intSim = new Sim();
  intSim.reset({ gen: 3, width: 8 });
  buildLoopbackBert(intSim, { gen: 3, width: 8, mode: 'internal' });
  intSim.runToEnd();

  const intPhases = intSim.phases.map((p) => p.key);
  for (const k of ['lpbk_cfg', 'lpbk_int', 'bert', 'lpbk_exit']) {
    assert.ok(intPhases.includes(k), `Internal 缺少阶段 ${k}`);
  }
  assert.ok(!intPhases.includes('lpbk_ext'), 'Internal 不应出现 External 阶段');
  assert.equal(intSim.bert.pattern, 'PRBS7');
  assert.equal(intSim.bert.pass, true);
  assert.equal(intSim.link.ports.RC.state, 'L0', 'Internal 不改变链路状态');
  assert.equal(intSim.loopback.snapshot().internalErrors, 3);
  assert.equal(intSim.loopback.snapshot().externalErrors, 0);

  // ---- External：经通道回环，结束后回到 Detect ----
  const extSim = new Sim();
  extSim.reset({ gen: 3, width: 8 });
  buildLoopbackBert(extSim, { gen: 3, width: 8, mode: 'external' });
  extSim.runToEnd();

  const extPhases = extSim.phases.map((p) => p.key);
  for (const k of ['lpbk_cfg', 'lpbk_ext', 'bert', 'lpbk_exit']) {
    assert.ok(extPhases.includes(k), `External 缺少阶段 ${k}`);
  }
  assert.ok(!extPhases.includes('lpbk_int'), 'External 不应出现 Internal 阶段');
  assert.equal(extSim.bert.pattern, 'PRBS31');
  assert.equal(extSim.bert.pass, true);
  assert.equal(extSim.link.ports.RC.state, 'Detect.Quiet');
  assert.ok(extSim.bert.injections.some((h) => h.ber > 1e-12));
  assert.equal(extSim.loopback.snapshot().internalErrors, 0);
  assert.equal(extSim.loopback.snapshot().externalErrors, 3);
});

test('Loopback 两种模式都支持选择 BERT 图案', () => {
  assert.equal(BERT_PATTERN_ORDER.length, 6);
  assert.deepEqual(BERT_PATTERN_ORDER, Object.keys(BERT_PATTERNS));
  for (const pattern of BERT_PATTERN_ORDER) {
    const sim = new Sim();
    sim.reset({ gen: 4, width: 4 });
    buildLoopbackBert(sim, { gen: 4, width: 4, pattern, mode: 'external' });
    sim.runToEnd();
    assert.equal(sim.bert.pattern, pattern);
    assert.equal(sim.bert.polynomial, BERT_PATTERNS[pattern].polynomial);
    assert.equal(sim.bert.pass, true);
  }
});

test('流控信用：消耗、归还与 Data 信用单位', () => {
  const fc = new FlowControl();
  fc.init({ header: 8, data: 32, cplData: 64 });
  assert.equal(fc.enabled, true);
  assert.equal(fc.available.RC.NP_Hdr, 8);

  fc.consume('RC', 'NP_Hdr', 1);
  assert.equal(fc.available.RC.NP_Hdr, 7);
  fc.give('RC', 'NP_Hdr', 1);
  assert.equal(fc.available.RC.NP_Hdr, 8);

  fc.consume('EP', 'Cpl_Hdr', 1);
  fc.consume('EP', 'Cpl_Data', 8);
  assert.equal(fc.available.EP.Cpl_Data, 56);
  fc.give('EP', 'Cpl_Hdr', 1);
  fc.give('EP', 'Cpl_Data', 8);
  assert.equal(fc.available.EP.Cpl_Data, 64);

  assert.equal(FlowControl.dataCredits(128), 8);
  assert.equal(FlowControl.dataCredits(32), 2);
});

test('内存模型：写入与读回', () => {
  const m = new Memory();
  assert.equal(m.read32(0x1000), 0xa0000000);
  m.write32(0x1000, 0xdeadbeef);
  assert.equal(m.read32(0x1000), 0xdeadbeef);
  m.writeDws(0x2000, [1, 2, 3]);
  assert.deepEqual(m.readDws(0x2000, 3), [1, 2, 3]);
  assert.equal(m.wrap(0x80001000), 0x1000);
});

test('内存读场景：MRd 拆分为 2 个 CplD，信用归还', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  const info = buildMemRead(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  const types = new Set(sim.events.map((e) => e.type));
  for (const t of ['InitFC1', 'InitFC2', 'MRd', 'CplD', 'UpdateFC', 'ACK', 'DONE']) {
    assert.ok(types.has(t), `缺少事件类型 ${t}`);
  }
  assert.equal(sim.events.filter((e) => e.type === 'CplD').length, 4, '2 个 Completion × TX/RX');
  assert.equal(sim.fc.initDone, true);
  assert.equal(sim.fc.available.RC.NP_Hdr, 8);
  assert.equal(sim.fc.available.EP.Cpl_Hdr, 8);
  assert.equal(sim.fc.available.EP.Cpl_Data, 64);
  assert.equal(info.rows.length, 5);
});

test('内存写场景：Posted 写 + 读回一致', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildMemWrite(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  const types = new Set(sim.events.map((e) => e.type));
  for (const t of ['InitFC1', 'InitFC2', 'MWr', 'MRd', 'CplD', 'UpdateFC', 'DONE']) {
    assert.ok(types.has(t), `缺少事件类型 ${t}`);
  }
  assert.equal(sim.mem.read32(0x80001000), 0xdeadbeef);
  assert.equal(sim.mem.read32(0x80001004), 0xcafebabe);
  assert.equal(sim.fc.available.RC.P_Hdr, 8);
  assert.equal(sim.fc.available.RC.P_Data, 32);
  assert.equal(sim.fc.available.RC.NP_Hdr, 8);
  assert.equal(sim.fc.available.EP.Cpl_Data, 64);

  const cpl = sim.events.find((e) => e.type === 'CplD' && e.packet && e.packet.tag === 2);
  assert.ok(cpl);
  assert.equal(cpl.packet.dataDws[0], 0xdeadbeef);
});

test('MSI / MSI-X 触发与 mask', () => {
  const m = new MsiModel();
  m.enableMsi(4);
  assert.equal(m.trigger(1), true);
  m.enableMsix();
  assert.equal(m.triggerMsix(2), true);
  m.maskMsix(2, true);
  assert.equal(m.triggerMsix(2), false);
  assert.equal(m.suppressed, 1);
  assert.equal(m.interrupts.length, 2);
});

test('AER 计数', () => {
  const a = new AerModel();
  a.enable();
  a.report('cor', 'Bad TLP');
  a.report('nonfatal', 'Unexpected Completion');
  a.report('fatal', 'Malformed TLP');
  assert.equal(a.correctable, 1);
  assert.equal(a.nonfatal, 1);
  assert.equal(a.fatal, 1);
  assert.equal(a.log.length, 3);
});

test('MSI 场景：MSI + MSI-X + mask', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildMsiInt(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  assert.equal(sim.msi.msiEnabled, true);
  assert.equal(sim.msi.msixEnabled, true);
  assert.equal(sim.msi.interrupts.length, 5);
  assert.equal(sim.msi.suppressed, 1);

  const types = new Set(sim.events.map((e) => e.type));
  for (const t of ['MSI', 'MSI-X', 'INT']) {
    assert.ok(types.has(t), `缺少事件类型 ${t}`);
  }
});

test('AER 场景：三类错误 + Hot Reset', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildAerError(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  assert.equal(sim.aer.correctable, 1);
  assert.equal(sim.aer.nonfatal, 1);
  assert.equal(sim.aer.fatal, 1);

  const types = new Set(sim.events.map((e) => e.type));
  for (const t of ['ERR_COR', 'ERR_NONFATAL', 'ERR_FATAL', 'INT', 'ERROR']) {
    assert.ok(types.has(t), `缺少事件类型 ${t}`);
  }
  assert.equal(sim.link.ports.RC.state, 'Detect.Quiet');
});

test('单步后退：恢复时钟与事件长度', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildMemWrite(sim, { gen: 3, width: 8 });

  assert.equal(sim.stepBack(), false, '没有历史时不能后退');

  sim.stepOnce();
  sim.stepOnce();
  sim.stepOnce();
  const t = sim.clock;
  const n = sim.events.length;
  sim.stepOnce();
  assert.ok(sim.events.length >= n);

  assert.equal(sim.stepBack(), true);
  assert.equal(sim.events.length, n);
  assert.equal(sim.clock, t);

  // 再次单步应重现同一事件
  sim.stepOnce();
  assert.ok(sim.events.length >= n);
});

test('后退可恢复内存与流控信用', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildMemWrite(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  const mem = sim.mem.read32(0x80001000);
  const pHdr = sim.fc.available.RC.P_Hdr;
  const npHdr = sim.fc.available.RC.NP_Hdr;
  const len = sim.events.length;

  for (let i = 0; i < 25; i += 1) sim.stepBack();
  assert.ok(sim.events.length < len);

  sim.runToEnd();
  assert.equal(sim.mem.read32(0x80001000), mem);
  assert.equal(sim.fc.available.RC.P_Hdr, pHdr);
  assert.equal(sim.fc.available.RC.NP_Hdr, npHdr);
});

test('后退可恢复配置空间 BAR 状态', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildEnumeration(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  const bar0 = sim.config.read(0x10);
  const command = sim.config.command;
  assert.equal(bar0, 0x80000000);

  for (let i = 0; i < 12; i += 1) sim.stepBack();
  sim.runToEnd();
  assert.equal(sim.config.read(0x10), bar0);
  assert.equal(sim.config.command, command);
});

test('PM 模型：D/P 状态与 PME', () => {
  const p = new PmModel();
  p.enable();
  assert.equal(p.dstate, 'D0');
  assert.equal(p.powerW, 10);

  p.setPState(1);
  assert.equal(p.powerW, 6);
  p.setPState(2);
  assert.equal(p.powerW, 3);

  p.writePmcsr(0x0001);
  assert.equal(p.dstate, 'D1');
  assert.equal(p.powerW, 1.5);
  assert.equal(p.setPState(0), false);

  p.writePmcsr(0x0103);
  assert.equal(p.dstate, 'D3hot');
  assert.equal(p.pmeEn, true);
  assert.equal(p.triggerPme(), true);
  assert.equal(p.pmeStatus, true);

  p.writePmcsr(0x8000);
  assert.equal(p.dstate, 'D0');
  assert.equal(p.pmeStatus, false);

  p.setDState('D3cold');
  assert.equal(p.powerW, 0);
  assert.equal(p.linkState, 'OFF');
});

test('PM D/P 场景：D1 / D3hot / PME / D3cold / 复位', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildPmDp(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  const phases = sim.phases.map((p) => p.key);
  for (const k of ['d0', 'd1', 'd3', 'wake', 'd3cold', 'reset']) {
    assert.ok(phases.includes(k), `缺少阶段 ${k}`);
  }
  const types = new Set(sim.events.map((e) => e.type));
  for (const t of ['PM', 'PM_PME', 'CfgWr0']) {
    assert.ok(types.has(t), `缺少事件类型 ${t}`);
  }

  assert.equal(sim.pm.dstate, 'D0');
  assert.equal(sim.pm.pstate, 0);
  assert.equal(sim.pm.pmeStatus, false);
  assert.equal(sim.link.ports.RC.state, 'L0');
  assert.equal(sim.link.linkUp, true);
});

test('Flit 打包：多 TLP、DLP 与填充', () => {
  const m1 = buildMem({
    write: true, address: 0x80001000, is64: true, lengthDw: 2,
    requester: 0, tag: 0, dataDws: [1, 2],
  });
  const m2 = buildMem({
    write: true, address: 0x80002000, is64: true, lengthDw: 1,
    requester: 0, tag: 1, dataDws: [3],
  });
  const f = buildFlit({ seq: 7, gen: 6, width: 8, tlps: [m1, m2] });

  assert.equal(f.bytes.length, 256);
  assert.equal(f.packed.length, 2);
  assert.equal(f.packed[0].offset, 0);
  assert.equal(f.packed[1].offset, m1.bytes.length);
  assert.equal(f.payloadBytes, m1.bytes.length + m2.bytes.length);
  assert.equal(f.padding, 236 - f.payloadBytes);
  assert.equal(f.bytes[236], 7);
  assert.equal(f.bytes[238], 2);
  assert.equal(f.overflow, false);
});

test('Flit FEC/CRC：可纠正与不可纠', () => {
  const f = buildFlit({ seq: 0, gen: 6, width: 8, payload: 'mw' });
  assert.equal(checkFlit(f, { bitErrors: 0 }).status, 'OK');
  assert.equal(checkFlit(f, { bitErrors: 2 }).status, 'CORRECTED');

  const bad = checkFlit(f, { bitErrors: 9 });
  assert.equal(bad.status, 'UNCORRECTABLE');
  assert.equal(bad.crc, 'FAIL');
  assert.equal(bad.retry, true);
});

test('Gen6 Flit 场景：打包 / FEC / 重传', () => {
  const sim = new Sim();
  sim.reset({ gen: 6, width: 8 });
  buildFlitGen6(sim, { width: 8 });
  sim.runToEnd();

  const types = new Set(sim.events.map((e) => e.type));
  for (const t of ['FLIT', 'FEC', 'NAK', 'RETRY', 'DONE']) {
    assert.ok(types.has(t), `缺少事件类型 ${t}`);
  }
  assert.equal(sim.link.flitMode, true);
  assert.equal(sim.link.ports.RC.state, 'L0');
  assert.equal(sim.flit.corrected, 1);
  assert.equal(sim.flit.uncorrectable, 1);
  assert.equal(sim.flit.retries, 1);
  assert.equal(sim.flit.crcFails, 1);
});

test('事件时间单调不减且落在计划时长内', () => {
  const sim = runScenario(5, 16);
  let last = -1;
  for (const ev of sim.events) {
    assert.ok(ev.t_ns >= last, `事件 ${ev.id} 时间倒退`);
    assert.ok(ev.t_ns <= sim.durationNs + 1e-6, `事件 ${ev.id} 超出时长`);
    last = ev.t_ns;
  }
  assert.ok(sim.durationNs > 0);
});

test('相同输入产生确定性事件序列', () => {
  const a = runScenario(4, 2).events.map((e) => `${e.t_ns}|${e.type}|${e.summary}`);
  const b = runScenario(4, 2).events.map((e) => `${e.t_ns}|${e.type}|${e.summary}`);
  assert.deepEqual(a, b);
});
