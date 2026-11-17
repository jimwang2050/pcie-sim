import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCfg, buildMem, buildCpl, decode } from '../js/core/tlp.js';
import { ConfigSpace } from '../js/core/config.js';
import { Scheduler } from '../js/core/scheduler.js';
import { Sim } from '../js/core/sim.js';
import { buildFlit, checkFlit } from '../js/core/flit.js';
import { buildFlitGen6 } from '../js/scenarios/flit_gen6.js';
import { buildMemRead } from '../js/scenarios/mem_read.js';
import { buildMemWrite } from '../js/scenarios/mem_write.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/nfm-headers.json', import.meta.url)));
const builders = { cfg: buildCfg, mem: buildMem, cpl: buildCpl };
const dwords = bytes => Array.from({ length: bytes.length / 4 }, (_, i) =>
  new DataView(Uint8Array.from(bytes).buffer).getUint32(i * 4, true).toString(16).padStart(8, '0'));
for (const v of fixtures.vectors) {
  test(`独立字段向量：${v.id}`, () => {
    assert.deepEqual(dwords(builders[v.builder](v.input).bytes), v.dwords);
    const independentBytes = v.dwords.flatMap(dw => {
      const value = Number.parseInt(dw, 16);
      return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24];
    });
    const packet = decode(independentBytes);
    assert.equal(packet.requester, v.input.requester);
    assert.equal(packet.tag, v.input.tag);
    if ('reg' in v.input) assert.equal(packet.reg, v.input.reg);
    if ('address' in v.input) assert.equal(packet.address, v.input.address);
    if ('byteCount' in v.input) assert.equal(packet.byteCount, v.input.byteCount);
  });
}

test('Length/Byte Count 的零编码语义及完整 64 位地址', () => {
  const m = buildMem({ lengthDw: 1024 });
  assert.equal(m.length, 1024);
  assert.equal(m.bytes[0], 0);
  const c = buildCpl({ dataDws: Array(1024).fill(0), byteCount: 4096 });
  assert.equal(c.length, 1024);
  assert.equal(c.byteCount, 4096);
  assert.equal(buildCpl({ dataDws: [1], byteCount: 1 }).byteCount, 1, '最后 DW 可有尾部未使能字节');
  const high = 0xfedcba9876543000n;
  assert.equal(buildMem({ address: high, is64: true }).address, high);
});

test('请求合法性：BE、4KB 边界、载荷/长度、无损输入', () => {
  for (const input of [
    { lengthDw: 0 }, { lengthDw: 1025 }, { address: 2 }, { address: 0xffc, lengthDw: 2 },
    { lengthDw: 2, lastBe: 0 }, { lengthDw: 1, lastBe: 15 },
    { lengthDw: 3, firstBe: 5 }, { write: true, lengthDw: 2, dataDws: [1] },
    { tag: 256 }, { address: 2 ** 54, is64: true }, { address: -4 },
  ]) assert.throws(() => buildMem(input), RangeError, JSON.stringify(input));
  assert.equal(buildMem({ lengthDw: 1, firstBe: 0 }).firstBe, 0);
  assert.equal(buildMem({ lengthDw: 2, firstBe: 5, lastBe: 10 }).lastBe, 10, 'QW 对齐的 2DW BE 例外');
  assert.throws(() => buildCfg({ reg: 3 }), RangeError);
  assert.throws(() => buildCpl({ dataDws: [1], byteCount: 0 }), RangeError);
  assert.throws(() => buildCpl({ dataDws: [1], status: 1 }), RangeError);
  assert.throws(() => buildCpl({ status: 2, requestKind: 'MRd' }), RangeError);
  assert.equal(buildCpl({ status: 2, requestKind: 'CfgRd0' }).status, 2);
  assert.throws(() => decode([0, 0]), RangeError);
  assert.throws(() => decode(buildMem().bytes.slice(0, -1)), RangeError);
  assert.throws(() => buildCpl({ dataDws: [1, 2], byteCount: 1 }), RangeError);
});

test('Completion 分包 Byte Count、地址和有效数据总量', () => {
  for (const [build, counts] of [[buildMemRead, [128, 64]], [buildMemWrite, [32]]]) {
    const s = new Sim(); s.reset(); build(s); s.runToEnd();
    const cpls = s.events.filter(e => e.dir === 'TX' && e.type === 'CplD').map(e => e.packet);
    assert.deepEqual(cpls.map(p => p.byteCount), counts);
    assert.equal(cpls.reduce((n, p) => n + p.dataBytes.length, 0), counts[0]);
    if (counts.length === 2) assert.deepEqual(cpls.map(p => p.lowerAddress), [0, 64]);
    assert.ok(cpls.every(p => p.bcm === 0));
  }
});

test('配置访问宽度、字节使能、RO、RW1C 和非法访问', () => {
  const c = new ConfigSpace();
  c.write16Raw(6, 0xf910); // Hardware/internal setup, not a software config write.
  c.write(4, 2, 2);
  assert.equal(c.read(6, 2), 0xf910);
  c.write(6, 0x8100, 2);
  assert.equal(c.read(6, 2), 0x7810);
  c.write(0, 0xffffffff);
  assert.equal(c.read(0), 0x56781234);
  c.write(4, 0x0407, 2, 1);
  assert.equal(c.command, 7);
  c.write(5, 4, 1);
  assert.equal(c.command, 0x407);
  for (const [off, size] of [[-1, 1], [1, 2], [4096, 1], [0, 3]]) assert.throws(() => c.read(off, size), RangeError);
  assert.throws(() => c.write(4, 256, 1), RangeError);
});

test('BAR 属性、独立高低 DWORD 探测、部分写与无损地址', () => {
  const c = new ConfigSpace();
  assert.equal(c.read(16), 4);
  c.write(16, 0xffffffff);
  assert.equal(c.read(16), 0xfffff004);
  assert.equal(c.read(20), 0, '低 DWORD 探测不改变高 DWORD');
  c.write(20, 0xffffffff);
  assert.equal(c.read(20), 0xffffffff);
  assert.equal(c.read(17, 1), 0xf0);
  c.write(16, 0x76543000); c.write(20, 0xfedcba98);
  assert.equal(c.baseHex(c.bars[0]), '0xFEDCBA9876543000');
  c.write(16, 0, 1);
  assert.equal(c.read(16) & 15, 4);
  c.write(16, 0, 4, 0);
  assert.equal(c.read(16), 0x76543004);
});

test('局部回退恢复 Flit 的完整故障状态，事件不可变', () => {
  const s = new Sim(); s.reset({ gen: 6 }); buildFlitGen6(s);
  while (s.clock < 22000) s.stepOnce();
  const original = structuredClone(s.events.at(-1));
  while (s.clock < 40000) s.stepOnce();
  while (s.clock >= 22000) s.stepBack();
  s.stepOnce();
  assert.deepEqual(s.events.at(-1), original);
  assert.throws(() => { s.events.at(-1).packet.check.status = 'future'; }, TypeError);
});

test('调度拒绝时间倒退；同刻稳定；零延迟循环明确停止原因', () => {
  const q = new Scheduler(); const seen = [];
  q.at(100, () => seen.push(1)); q.at(100, () => seen.push(2)); q.step(); q.step();
  assert.deepEqual(seen, [1, 2]);
  for (const t of [10, NaN, Infinity, -1]) assert.throws(() => q.at(t, () => {}), RangeError);
  assert.throws(() => q.at(100, null), TypeError);
  assert.throws(() => q.after(-1, () => {}), RangeError);
  const s = new Sim(); const repeat = () => s.after(0, repeat); s.at(0, repeat);
  assert.equal(s.runToEnd(5), 5); assert.equal(s.stopReason, 'step-limit'); assert.equal(s.finished, false);
});

test('Flit 不冒充真实编码/校验，不按误码数猜纠错能力', () => {
  const f = buildFlit();
  assert.equal(f.wireCompatible, false); assert.equal(f.crc.implemented, false);
  assert.ok(f.bytes.slice(242).every(b => b === 0));
  f.bytes[0] ^= 1;
  assert.equal(checkFlit(f).verified, false);
  assert.throws(() => checkFlit(f, { bitErrors: 2 }), RangeError);
  assert.equal(checkFlit(f, { bitErrors: 9, outcome: 'corrected' }).status, 'CORRECTED');
  assert.equal(checkFlit(f, { bitErrors: 1, outcome: 'uncorrectable' }).status, 'UNCORRECTABLE');
});
