import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowControl } from '../js/core/fc.js';
import { Transactions } from '../js/core/transactions.js';
import {
  BertModel, bertVerdict, bitsForTarget, targetFor, zeroErrorUpperBound,
} from '../js/core/bert.js';
import { MsiModel } from '../js/core/msi.js';
import { AerModel } from '../js/core/aer.js';
import { DpcModel } from '../js/core/dpc.js';
import { AtsModel } from '../js/core/ats.js';
import { Sim } from '../js/core/sim.js';
import { buildMemRead } from '../js/scenarios/mem_read.js';
import { buildMemWrite } from '../js/scenarios/mem_write.js';
import { buildLoopbackBert } from '../js/scenarios/loopback_bert.js';

test('M2/FC：Header 不足时 Data 也不扣，且不出现负信用', () => {
  const fc = new FlowControl();
  fc.init({ header: 1, data: 4, cplData: 4 });
  assert.equal(fc.canSend('RC', { NP_Hdr: 2, NP_Data: 1 }), false);
  const r = fc.reserve('RC', { NP_Hdr: 2, NP_Data: 1 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['NP_Hdr']);
  assert.equal(fc.available.RC.NP_Hdr, 1, 'Header 不足时不应扣减');
  assert.equal(fc.available.RC.NP_Data, 4, 'Data 不应被单独扣减');
  assert.equal(fc.blocked.RC, 1);

  assert.equal(fc.reserve('RC', { NP_Hdr: 1, NP_Data: 1 }).ok, true);
  assert.equal(fc.available.RC.NP_Hdr, 0);
  assert.equal(fc.available.RC.NP_Data, 3);
  assert.equal(fc.reserve('RC', { NP_Hdr: 1 }).ok, false);
  assert.ok(fc.available.RC.NP_Hdr >= 0);
});

test('M2/FC：归还不超过通告上限，重复归还可见', () => {
  const fc = new FlowControl();
  fc.init({ header: 2, data: 2, cplData: 2 });
  fc.reserve('RC', { P_Hdr: 2, P_Data: 2 });
  fc.release('RC', { P_Hdr: 1, P_Data: 1 });
  const r = fc.release('RC', { P_Hdr: 5, P_Data: 5 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.over, { P_Hdr: 4, P_Data: 4 });
  assert.equal(fc.available.RC.P_Hdr, 2);
  assert.equal(fc.available.RC.P_Data, 2);
  assert.equal(fc.overReturned.RC, 1);
});

test('M2/事务：Tag 冲突、分包累计、无匹配与超时', () => {
  const tx = new Transactions();
  assert.equal(tx.begin({ requester: 0x0100, tag: 3, kind: 'MRd', lengthBytes: 128 }).ok, true);
  assert.equal(tx.begin({ requester: 0x0100, tag: 3 }).ok, false);
  assert.equal(tx.stats.duplicates, 1);

  const c1 = tx.complete({ requester: 0x0100, tag: 3, byteCount: 128, dataBytes: 64 });
  assert.equal(c1.ok, true);
  assert.equal(c1.done, false);
  assert.equal(c1.tx.remaining, 64, 'Byte Count 含本包，扣掉 64B 后仍剩 64B');
  assert.equal(tx.pending, 1);

  const c2 = tx.complete({ requester: 0x0100, tag: 3, byteCount: 64, dataBytes: 64, lowerAddress: 0x40 });
  assert.equal(c2.done, true);
  assert.equal(tx.pending, 0);
  assert.equal(tx.stats.completed, 1);

  const bad = tx.complete({ requester: 0x0100, tag: 9, byteCount: 4, dataBytes: 4 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'no-request');
  assert.equal(tx.stats.unexpected, 1);

  tx.begin({ requester: 0x0200, tag: 1, kind: 'CfgRd0', lengthBytes: 4 });
  assert.equal(tx.expire(49999, 50000).length, 0);
  assert.equal(tx.expire(50000, 50000).length, 1);
  assert.equal(tx.stats.timeouts, 1);
});

test('M2/BERT：零样本、未锁定、样本不足都不判 PASS', () => {
  const b = new BertModel();
  b.start('PRBS31');
  assert.equal(b.verdict, 'NOT-LOCKED');
  b.lock();
  assert.equal(b.verdict, 'NO-SAMPLE');

  b.accumulate(1e9, 0);
  assert.equal(b.verdict, 'INSUFFICIENT', '1 Gb 零错误不足以在 1e-12 目标下判 PASS');
  assert.equal(b.pass, false);
  assert.ok(b.upperBound > 1e-12);
  assert.ok(Math.abs(zeroErrorUpperBound(1e9) - 3e-9) < 1e-10);

  b.inject(3);
  assert.equal(b.verdict, 'FAIL');

  b.clear();
  b.accumulate(b.bitsNeeded, 0);
  assert.equal(b.verdict, 'PASS');
  assert.ok(b.upperBound <= b.targetBer);
});

test('M2/BERT：Gen6 用 PAM4 FBER，低代际用 BER 1e-12', () => {
  assert.equal(targetFor(5), 1e-12);
  assert.equal(targetFor(6), 1e-6);
  assert.ok(bitsForTarget(1e-12) > 2.9e12 && bitsForTarget(1e-12) < 3.1e12);

  const same = { enabled: true, locked: true, bits: 1e9, errors: 0 };
  assert.equal(bertVerdict({ ...same, targetBer: 1e-12 }), 'INSUFFICIENT');
  assert.equal(bertVerdict({ ...same, targetBer: 1e-6 }), 'PASS');

  const withErrors = { enabled: true, locked: true, bits: 1e9, errors: 3 };
  assert.equal(bertVerdict({ ...withErrors, targetBer: 1e-12 }), 'FAIL');
  assert.equal(bertVerdict({ ...withErrors, targetBer: 1e-6 }), 'PASS',
    '同样的 3 个错误在 PAM4 FBER 目标下仍合格');
});

test('M2/BERT 场景：不同代际使用不同目标且最终判 PASS', () => {
  for (const gen of [3, 6]) {
    const sim = new Sim();
    sim.reset({ gen, width: 8 });
    buildLoopbackBert(sim, { gen, width: 8 });
    sim.runToEnd();
    assert.equal(sim.bert.targetBer, targetFor(gen));
    assert.equal(sim.bert.gen, gen);
    assert.equal(sim.bert.verdict, 'PASS');
  }
});

test('M2/MSI-X：Mask 期间置 Pending，解除后补发', () => {
  const m = new MsiModel();
  m.enableMsix();
  m.maskMsix(2, true);
  assert.equal(m.triggerMsix(2), false);
  assert.equal(m.snapshot().pending, 1);
  assert.equal(m.interrupts.length, 0, '被 mask 时不应产生中断');

  assert.equal(m.maskMsix(2, false), 1);
  assert.equal(m.interrupts.length, 1);
  assert.equal(m.interrupts[0].pending, true, '补发的中断应标记来自 Pending');
  assert.equal(m.pendingDelivered, 1);

  m.setFunctionMask(true);
  assert.equal(m.triggerMsix(1), false);
  assert.equal(m.snapshot().pending, 1);
  assert.equal(m.setFunctionMask(false), 1);
  assert.equal(m.interrupts.length, 2);
});

test('M2/AER：Mask 只抑制消息，Severity 决定上报级别', () => {
  const a = new AerModel();
  a.enable();
  a.setMask('nonfatal', true);
  const masked = a.report('nonfatal', 'Unexpected Completion');
  assert.equal(masked.ok, false);
  assert.equal(masked.reason, 'masked');
  assert.equal(a.nonfatal, 1, '被 Mask 的错误仍然计数');
  assert.equal(a.messages, 0);
  assert.equal(a.masked, 1);

  a.setMask('nonfatal', false);
  a.setSeverity('nonfatal', 'fatal');
  const r = a.report('nonfatal', 'Malformed TLP');
  assert.equal(r.ok, true);
  assert.equal(r.severity, 'fatal');
  assert.equal(a.fatal, 1);
  assert.equal(a.messages, 1);

  const b = new AerModel();
  assert.equal(b.report('cor', 'Bad TLP').reason, 'disabled');
  assert.equal(b.correctable, 1);
});

test('M2/DPC：RP PIO 只对 Non-Posted 合成 Completion', () => {
  const d = new DpcModel();
  d.enable();
  assert.equal(d.urCompletion('mem-read'), true);
  assert.equal(d.urCompletion('posted'), false);
  const s = d.snapshot();
  assert.equal(s.urCompletions, 1);
  assert.equal(s.postedDropped, 1);
});

test('M2/ATS：被失效的 ATC 条目不能再命中', () => {
  const a = new AtsModel();
  a.enable();
  a.fill(0x1000, 0x9000);
  assert.equal(a.lookup(0x1000), true);
  a.invalidate(0x1000);
  assert.equal(a.lookup(0x1000), false);
  assert.equal(a.invalidations, 1);
  assert.equal(a.cache.length, 0);
});

test('M2/场景：内存写信用耗尽阻塞一次，重发一次且无负信用', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildMemWrite(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  assert.equal(sim.fc.blocked.RC, 1);
  assert.equal(sim.fc.overReturned.RC, 0);
  assert.equal(sim.fc.available.RC.P_Hdr, 8);
  assert.equal(sim.fc.available.RC.P_Data, 2);
  assert.ok(Object.values(sim.fc.available.RC).every((v) => v >= 0));

  const blocked = sim.events.filter((e) => e.type === 'FCBLOCK');
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].summary, /阻塞/);
  const sent = sim.events.filter((e) => e.type === 'MWr' && e.dir === 'TX');
  assert.equal(sent.length, 2, '每个 MWr 只发送一次（阻塞的那次没有产生 TLP）');
});

test('M2/场景：内存读的 Completion 事务匹配完整结束', () => {
  const sim = new Sim();
  sim.reset({ gen: 3, width: 8 });
  buildMemRead(sim, { gen: 3, width: 8 });
  sim.runToEnd();

  assert.equal(sim.tx.stats.started, 1);
  assert.equal(sim.tx.stats.completed, 1);
  assert.equal(sim.tx.stats.unexpected, 0);
  assert.equal(sim.tx.pending, 0);
  assert.ok(sim.events.some((e) => e.type === 'TXMATCH' && e.summary.includes('事务完成')));
});
