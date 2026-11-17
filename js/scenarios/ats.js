import { resolveScenarioConfig } from './registry.js';
/**
 * 场景：ATS（Address Translation Services）+ PRI（Page Request Interface）。
 *
 * 覆盖：
 *  - 软件使能 ATS（Enable / STU）与 PRI（Enable / PRG）
 *  - ATC Miss → Translation Request（AT=01b）→ Translation Completion
 *  - ATC Hit → 直接使用缓存的翻译地址（AT=10b）
 *  - 非法 Translation Request → Invalid Request（UR），设备丢弃结果
 *  - 页表更新 → Invalidate Request / Invalidate Completion，清除 ATC
 *  - 缺页 → Page Request → PRG Response → 重试翻译成功
 */
import { buildMem, buildCpl, buildMsg } from '../core/tlp.js';
import {
  setupLinkL0, tlpPair, ackPair, US, RC_ID, EP_ID,
} from './mem_common.js';

const VA1 = 0x7f001000;
const PA1 = 0xc0001000;
const BAD_VA = 0x7f0ff800;
const VA2 = 0x7f200000;
const PA2 = 0xc0200000;

function hex(v) {
  return `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Translation Request：MRd 格式，AT=01b；地址字段填未翻译地址（VA）。 */
function trPacket(va, tag, { invalid = false } = {}) {
  const p = buildMem({
    write: false, address: va, is64: true, lengthDw: 1,
    requester: EP_ID, tag, at: 1,
  });
  p.name = 'TR';
  p.summary = `Translation Request  VA=${hex(va)}  Tag=0x${tag.toString(16).toUpperCase()}`;
  p.fields.splice(2, 0, {
    name: 'AT', value: '0b01', display: '01b · Translation Request',
    desc: 'Address Type：01b 表示本 TLP 请求地址翻译（不做内存访问）',
  });
  p.fields.push({
    name: 'Tag / STU', value: String(tag),
    display: `Tag ${tag} · STU 4 KB`,
    desc: 'Tag 用于匹配 Translation Completion；STU 为最小翻译粒度',
  });
  if (invalid) {
    p.fields.push({
      name: '非法性', value: '1', display: 'VA 越界 / 请求格式非法',
      desc: 'Translation Agent 无法受理该请求，将返回 Invalid Request',
    });
  }
  return p;
}

/** Translation Completion：Cpl 格式，返回翻译结果或 Invalid Request。 */
function tcPacket({ tag, translated = true, pa = PA1, invalid = false }) {
  const status = invalid ? 1 : 0;
  const p = buildCpl({ requester: EP_ID, completer: RC_ID, tag, status });
  p.name = 'TC';
  p.summary = invalid
    ? `Translation Completion  Status=UR（Invalid Request）  Tag=0x${tag.toString(16).toUpperCase()}`
    : `Translation Completion  Status=SC  PA=${hex(pa)}  Tag=0x${tag.toString(16).toUpperCase()}`;
  p.fields.push({
    name: 'Translated', value: invalid ? '-' : '1',
    display: invalid ? '-' : '1（已翻译）',
    desc: '置 1 表示后续访问可直接使用 Translation Completion 中的地址',
  });
  p.fields.push({
    name: 'Translated Address', value: invalid ? '-' : hex(pa),
    display: invalid ? '-' : hex(pa),
    desc: '物理地址（PA）：ATC 命中时设备直接用它发起访问',
  });
  if (invalid) {
    p.fields.push({
      name: 'Invalid Request', value: '1',
      display: '1 · 请求被拒绝',
      desc: '非法 Translation Request，设备不得把该结果写入 ATC',
    });
  }
  return p;
}

/** ATS Invalidate Request / Invalidate Completion（Message 0x20 / 0x21）。 */
function invPacket({ completion = false, itag = 1 } = {}) {
  const p = buildMsg({ code: completion ? 0x21 : 0x20, requester: completion ? EP_ID : RC_ID, tag: 0 });
  p.name = completion ? 'INVC' : 'INV';
  p.summary = completion
    ? `Invalidate Completion  ITag=${itag}`
    : `Invalidate Request  ITag=${itag}  VA 范围 ${hex(VA1)}`;
  p.fields.push({
    name: 'ITag', value: String(itag), display: String(itag),
    desc: 'Invalidation Tag：请求与完成一一对应',
  });
  if (!completion) {
    p.fields.push({
      name: '地址范围', value: hex(VA1), display: `${hex(VA1)} · 1 个 STU（4 KB）`,
      desc: '可指定单地址、地址范围或 Global Invalidate（整表失效）',
    });
  }
  return p;
}

/** PRI Page Request / PRG Response（Message 0x04 / 0x05）。 */
function pageReqPacket({ response = false, prg = 0, code = 0 } = {}) {
  const p = buildMsg({ code: response ? 0x05 : 0x04, requester: response ? RC_ID : EP_ID, tag: 0 });
  p.name = response ? 'PRG' : 'PRQ';
  p.summary = response
    ? `PRG Response  PRG=${prg}  Response Code=${code === 0 ? 'Success' : code}`
    : `Page Request  PRG=${prg}  VA=${hex(VA2)}`;
  p.fields.push({
    name: 'PRG Index', value: String(prg), display: String(prg),
    desc: 'Page Request Group：同一组缺页共享一次响应',
  });
  p.fields.push(response ? {
    name: 'Response Code', value: String(code),
    display: code === 0 ? '0 · Success（映射已建立）' : `${code} · Failure`,
    desc: 'PRG Response 结果：成功后设备可重新发起翻译',
  } : {
    name: 'Page Request', value: hex(VA2), display: `${hex(VA2)} · Read`,
    desc: '页缺失描述符：告知 RC 哪个 VA 缺页，请求建立映射',
  });
  return p;
}

export function buildAts(sim, opts = {}) {
  resolveScenarioConfig('ats', opts);
  const gen = opts.gen ?? 3;
  const width = opts.width ?? 8;
  setupLinkL0(sim, gen, width, [
    { key: 'STATE', label: 'LTSSM 状态' },
    { key: 'RC.TL', label: 'RC · TL' },
    { key: 'RC.DLL', label: 'RC · DLL' },
    { key: 'EP.DLL', label: 'EP · DLL' },
    { key: 'EP.TL', label: 'EP · TL' },
  ]);

  const link = sim.link;
  const ats = sim.ats;
  ats.reset();

  // ---------- 1. 使能 ATS / PRI ----------
  sim.at(0, () => {
    sim.beginPhase('ats_cfg', 'ATS / PRI 使能', 'ats',
      '枚举 ATS Capability（0x0F）与 PRI Capability（0x13）：Enable=1、STU=4 KB、PRG 0');
    link.setBoth('L0', 'RC / EP：L0（链路正常工作）', 'ATS 尚未启用，设备只能使用未翻译地址');
  });

  sim.at(4 * US, () => {
    ats.enable({ stu: 4096 });
    ats.enablePri(0);
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'ATS',
      summary: '软件使能 ATS 与 PRI：ATS Enable=1 · STU=4 KB · PRI Enable=1 · PRG 0',
      detail: 'ATS Control.STU 决定最小翻译粒度；PRI 使能后设备才能上报缺页',
      status: 'ok',
    });
  });

  // ---------- 2. ATC Miss → Translation Request ----------
  sim.at(16 * US, () => sim.beginPhase('ats_miss', 'Translation Request · ATC Miss', 'ats',
    'EP 的 ATC 未命中，向 RC 内的 Translation Agent 发起地址翻译'));
  sim.at(20 * US, () => {
    ats.lookup(VA1);
    ats.request();
    sim.emit({
      layer: 'TL', row: 'EP.TL', side: 'EP', dir: 'TX', type: 'ATS',
      summary: `EP 发起 DMA 访问：VA=${hex(VA1)}（ATC miss）`,
      detail: 'ATC 无该 VA 的有效条目，必须先翻译再访问内存',
      status: 'ok',
    });
  });
  tlpPair(sim, 24 * US, 'EP', 'RC', trPacket(VA1, 5),
    `Translation Request  VA=${hex(VA1)}  Tag=5`,
    'AT=01b：请求翻译但不做内存访问；RC 的 Translation Agent 查询页表', null, 'TR');
  ackPair(sim, 28 * US, 'RC', 'EP', 'Translation Request');
  tlpPair(sim, 34 * US, 'RC', 'EP', tcPacket({ tag: 5, pa: PA1 }),
    `Translation Completion  PA=${hex(PA1)}  Tag=5`,
    'Translated=1：页表命中，返回物理地址；EP 可写入 ATC', null, 'TC');
  sim.at(38 * US, () => {
    ats.fill(VA1, PA1);
    ats.complete();
    sim.emit({
      layer: 'TL', row: 'EP.TL', side: 'EP', dir: 'RX', type: 'ATC',
      summary: `ATC 填充：${hex(VA1)} → ${hex(PA1)}（4 KB）`,
      detail: '翻译结果按 STU 粒度缓存；后续同一 VA 不再产生 Translation Request',
      status: 'ok',
    });
  });

  // ---------- 3. ATC Hit → 直接使用缓存翻译 ----------
  sim.at(48 * US, () => sim.beginPhase('ats_hit', 'ATC 命中 · 直接访问', 'ats',
    '同一 VA 再次访问，命中 ATC，省去一次翻译往返'));
  sim.at(52 * US, () => {
    ats.lookup(VA1);
    sim.emit({
      layer: 'TL', row: 'EP.TL', side: 'EP', dir: 'TX', type: 'ATC',
      summary: `ATC hit：${hex(VA1)} → ${hex(PA1)}`,
      detail: '翻译已缓存，延迟从“两次往返”降为“一次访问”',
      status: 'ok',
    });
  });
  tlpPair(sim, 56 * US, 'EP', 'RC',
    buildMem({ write: false, address: PA1, is64: true, lengthDw: 4, requester: EP_ID, tag: 7, at: 2 }),
    `MRd（AT=10b Translated） PA=${hex(PA1)}  Tag=7`,
    'AT=10b：地址字段已是物理地址，RC 不再翻译，直接访问内存', null, 'MRd');
  ackPair(sim, 60 * US, 'RC', 'EP', 'MRd (Translated)');
  tlpPair(sim, 64 * US, 'RC', 'EP',
    buildCpl({ requester: EP_ID, completer: RC_ID, tag: 7, dataDws: [0xdeadbeef, 0x11223344], byteCount: 8 }),
    'CplD  Tag=7  8B', '数据返回，本次访问完成', null, 'CplD');

  // ---------- 4. 非法 Translation Request ----------
  sim.at(76 * US, () => sim.beginPhase('ats_invalid', '非法 Translation Request', 'ats',
    '地址越界 / 请求格式非法时，Translation Agent 返回 Invalid Request（UR）'));
  sim.at(80 * US, () => {
    ats.request();
    sim.emit({
      layer: 'TL', row: 'EP.TL', side: 'EP', dir: 'TX', type: 'ATS',
      summary: `EP 发出非法 TR：VA=${hex(BAD_VA)}（越界 / 未映射到该设备）`,
      detail: '非法请求不会建立映射；设备不能据此更新 ATC',
      status: 'error',
    });
  });
  tlpPair(sim, 84 * US, 'EP', 'RC', trPacket(BAD_VA, 6, { invalid: true }),
    `Translation Request  VA=${hex(BAD_VA)}  Tag=6`,
    'AT=01b，但地址/格式不合法', null, 'TR', 'error');
  tlpPair(sim, 90 * US, 'RC', 'EP', tcPacket({ tag: 6, invalid: true }),
    'Translation Completion  Status=UR（Invalid Request）  Tag=6',
    'Translation Agent 拒绝该请求；EP 收到 UR 后必须丢弃结果，不能写入 ATC',
    () => ats.invalidRequest(), 'TC', 'error');
  sim.at(96 * US, () => {
    sim.emit({
      layer: 'TL', row: 'EP.TL', side: 'EP', dir: 'RX', type: 'ATS',
      summary: 'EP 处理 Invalid Request：丢弃翻译结果，本次访问失败',
      detail: '可回退为 Untranslated 访问，或向软件上报 ATS Invalid Request 错误',
      status: 'error',
    });
  });

  // ---------- 5. Invalidate Request → 清 ATC ----------
  sim.at(106 * US, () => sim.beginPhase('ats_inval', 'Invalidate Request · ATC 失效', 'ats',
    '页表更新后 RC 发 Invalidate Request，EP 清除对应 ATC 条目并回 Invalidate Completion'));
  sim.at(110 * US, () => {
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'ATS',
      summary: `页表更新：${hex(VA1)} 的映射已改变，必须让 EP 的 ATC 失效`,
      detail: '否则设备会继续用旧翻译访问错误物理页',
      status: 'ok',
    });
  });
  tlpPair(sim, 114 * US, 'RC', 'EP', invPacket(),
    `Invalidate Request  ITag=1  VA=${hex(VA1)}`,
    'ATS Invalidation：Message 0x20，可由 RC 或 IOMMU 发起', null, 'INV');
  sim.at(120 * US, () => {
    ats.invalidate(VA1);
    sim.emit({
      layer: 'TL', row: 'EP.TL', side: 'EP', dir: 'RX', type: 'ATC',
      summary: `EP 清除 ATC 条目：${hex(VA1)}（ITag=1）`,
      detail: '失效后同一 VA 的访问会重新产生 Translation Request',
      status: 'ok',
    });
  });
  tlpPair(sim, 126 * US, 'EP', 'RC', invPacket({ completion: true, itag: 1 }),
    'Invalidate Completion  ITag=1',
    '设备确认失效完成，RC 才可认为旧翻译不再被使用', null, 'INVC');
  sim.at(132 * US, () => {
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'DONE',
      summary: 'Invalidate 完成：ATC 已与页表一致',
      detail: '后续访问重新翻译，可能命中页表或触发缺页',
      status: 'ok',
    });
  });

  // ---------- 6. PRI：缺页 → Page Request → PRG Response ----------
  sim.at(140 * US, () => sim.beginPhase('page_request', 'PRI · Page Request（缺页）', 'pri',
    '访问未映射页：EP 通过 PRI 发 Page Request，映射建立后由 PRG Response 通知重试'));
  sim.at(144 * US, () => {
    ats.lookup(VA2);
    ats.pageRequest();
    sim.emit({
      layer: 'TL', row: 'EP.TL', side: 'EP', dir: 'TX', type: 'PRI',
      summary: `EP 访问 VA=${hex(VA2)}：页未映射（Page Not Present）`,
      detail: 'ATC miss 且页表无有效映射，设备不能自行处理，只能上报缺页',
      status: 'ok',
    });
  });
  tlpPair(sim, 148 * US, 'EP', 'RC', pageReqPacket({ prg: 0 }),
    `Page Request  PRG=0  VA=${hex(VA2)}`,
    'PRI：Message 0x04，携带 Page Request Group Index 与缺页地址', null, 'PRQ');
  sim.at(156 * US, () => {
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'PRI',
      summary: 'RC / IOMMU 处理缺页：建立 VA → PA 映射',
      detail: '由缺页处理程序分配物理页并更新页表（也可由硬件 ATS 直接填充）',
      status: 'ok',
    });
  });
  tlpPair(sim, 162 * US, 'RC', 'EP', pageReqPacket({ response: true, prg: 0, code: 0 }),
    'PRG Response  PRG=0  Success',
    '映射已建立，允许 EP 重新发起翻译', () => ats.prgResponse(), 'PRG');
  tlpPair(sim, 168 * US, 'EP', 'RC', trPacket(VA2, 8),
    `Translation Request（重试）  VA=${hex(VA2)}  Tag=8`,
    '收到 Success 后重试翻译，这一次页表已有效', () => ats.request(), 'TR');
  tlpPair(sim, 174 * US, 'RC', 'EP', tcPacket({ tag: 8, pa: PA2 }),
    `Translation Completion  PA=${hex(PA2)}  Tag=8`,
    'Translated=1：返回新映射的物理地址', null, 'TC');
  sim.at(178 * US, () => {
    ats.fill(VA2, PA2);
    ats.complete();
    sim.emit({
      layer: 'TL', row: 'EP.TL', side: 'EP', dir: 'RX', type: 'ATC',
      summary: `ATC 填充：${hex(VA2)} → ${hex(PA2)}，数据访问继续`,
      detail: 'PRI + ATS 组合让设备在缺页时不必挂死，也不需要软件完整代跑访问',
      status: 'ok',
    });
  });

  // ---------- 7. 完成 ----------
  sim.at(186 * US, () => {
    sim.beginPhase('ats_done', 'ATS 流程完成', 'ats');
    sim.emit({
      layer: 'STATE', row: 'STATE', type: 'DONE',
      summary: `ATS 完成：翻译 ${ats.requests} 次 · ATC 命中 ${ats.hits} · 非法 ${ats.invalidRequests} · 失效 ${ats.invalidations}`,
      detail: `PRI：Page Request ${ats.pageRequests} 次 · PRG Response ${ats.prgResponses} 次；ATC 现有 ${ats.cache.length} 项`,
      status: 'ok',
    });
  });
  sim.at(192 * US, () => sim.endPhase());

  sim.durationNs = 200 * US;
  return {
    gen,
    width,
    durationNs: sim.durationNs,
    totalSteps: sim.pending,
    rows: sim.rows,
    defaultRow: null,
  };
}
