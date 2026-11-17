/**
 * 场景：Loopback + BERT —— Internal 与 External 是两套「互相独立」的测试配置。
 *
 * 注意：二者不是先后状态，也不是切换过程。由顶栏「环回」选择其一，一次只运行一种：
 *  - Internal Loopback：TX 在器件内部直接回送到 RX（近端 / 数字环回），不需要对端参与，
 *    链路状态保持不变；用于 SerDes / PLL / CDR 自检，常用短序列 PRBS7。
 *  - External Loopback：RC 发带 Loopback 位的 TS1，EP 作为 Loopback Slave 经通道回环，
 *    覆盖封装、PCB、连接器与线缆；用于链路电气与通道裕量验证，常用长序列。
 * 两种配置都各自完成 BERT 测量（PRBS7/9/11/15/23/31）与误码注入判定。
 */
import { buildOrderedSet, ratesBitmap } from '../core/packet.js';
import { formatBits, patternInfo } from '../core/bert.js';

const US = 1000;

export function buildLoopbackBert(sim, opts = {}) {
  const gen = opts.gen ?? 3;
  const width = opts.width ?? 8;
  const pattern = opts.pattern || 'PRBS31';
  const mode = opts.mode === 'internal' ? 'internal' : 'external';
  const link = sim.link;
  const phy = sim.phy;
  const bert = sim.bert;
  const lpbk = sim.loopback;

  link.configure({ gen, width, mode: 'auto' });
  link.reset();
  link.linkUp = true;
  link.setRate(gen);
  link.setLaneNumbers(Array.from({ length: width }, (_, i) => i));
  phy.reset(gen, width);
  phy.stabilizeRefClk();
  phy.lockPll();
  phy.cdrBitLock();
  phy.setOperatingRate(gen);
  phy.setEqPhase(gen >= 3 ? 3 : 0, gen >= 3 ? phy.bestPreset() : 0);

  sim.rows = [
    { key: 'STATE', label: 'LTSSM 状态' },
    { key: 'RC.PHY', label: 'RC · PHY' },
    { key: 'EP.PHY', label: 'EP · PHY' },
  ];

  const laneAll = Array.from({ length: width }, (_, i) => i);
  const rates = ratesBitmap(gen);
  const nFts = gen <= 2 ? 4 : 12;

  const at = (t, fn) => sim.at(t, fn);

  function state(t, st, summary, detail) {
    at(t, () => link.setBoth(st, summary, detail));
  }

  function ev(t, side, type, summary, detail, mutate) {
    at(t, () => {
      if (mutate) mutate();
      sim.emit({
        layer: 'PHY',
        row: side === null ? 'STATE' : `${side}.PHY`,
        side,
        dir: '-',
        type,
        summary: typeof summary === 'function' ? summary() : summary,
        detail: typeof detail === 'function' ? detail() : detail,
        status: 'ok',
        dur_ns: 0,
      });
    });
  }

  function bertText(label) {
    const s = bert.snapshot();
    const ber = s.errors === 0 ? '0' : s.ber.toExponential(1);
    return `BERT ${s.pattern}（${label}）：${formatBits(s.bits)}，${s.errors} errors，BER ${ber}（${s.pass ? 'PASS' : 'FAIL'}）`;
  }

  function bertPhase(startT, label, errorDetail) {
    at(startT, () => sim.beginPhase('bert', 'BERT 误码注入与判定', 'bert',
      '注入比特错误，BER 超过目标后 FAIL；清除计数重新测量恢复 PASS'));
    ev(startT + 4 * US, 'RC', 'BERTERR',
      `注入 3 个比特错误（${label}）`, errorDetail,
      () => {
        bert.inject(3);
        lpbk.addErrors(3);
      });
    ev(startT + 16 * US, 'RC', 'BERT', () => bertText(label),
      '错误累计后 BER 超过 1e-12 目标 → FAIL',
      () => bert.accumulate(1e9, 0));
    ev(startT + 30 * US, 'RC', 'BERT', '清除 BERT 计数器，开始新一轮测量',
      '重新测量后若窗口内无错误，则恢复 PASS', () => bert.clear());
    ev(startT + 42 * US, 'RC', 'BERT', () => bertText(label),
      '新一轮测量窗口：无错误 → PASS', () => bert.accumulate(1e9, 0));
  }

  // ================= Internal Loopback（独立测试） =================
  function buildInternal() {
    at(0, () => {
      sim.beginPhase('lpbk_cfg', 'Internal Loopback 配置（独立测试）', 'loopback',
        '只配置器件内部回环：TX → RX 在 RC.PHY 内部完成，不需要 EP 参与，也不改变链路状态');
      link.setBoth('L0', 'RC / EP：L0（不受 Internal 测试影响）',
        'Internal 环回是器件自测模式，链路仍保持 L0');
    });

    ev(8 * US, null, 'LOOPBACK',
      'Internal 与 External 是两套独立配置：顶栏「环回」选择，一次只运行一种',
      '两者目标不同，不能把 Internal 的结果当作通道验证，也不存在从 Internal “切到” External 的状态迁移');

    ev(14 * US, 'RC', 'LOOPBACK',
      '启用 Internal（近端 / 数字）环回：RC.PHY TX → RX',
      '回环点在器件内部，封装、通道与连接器都不参与；通道损耗视为 0 dB');

    at(18 * US, () => {
      sim.beginPhase('lpbk_int', 'Internal Loopback 测试', 'lpbk_int',
        '短序列 PRBS7 快速锁定，验证 SerDes / PLL / CDR 自身的发送与采样通路');
      lpbk.enter('internal', 'PRBS7');
      bert.start('PRBS7');
    });
    ev(22 * US, 'RC', 'PATTERN',
      () => `BERT 启动：PRBS7（${patternInfo('PRBS7').polynomial}，周期 ${patternInfo('PRBS7').period} bit）`,
      '近端自检用短序列：锁定快，但覆盖的连 0/1 较短');
    ev(28 * US, 'RC', 'BERT', 'PRBS7 图案锁定', 'Checker 与 LFSR 同步，开始累计比特', () => bert.lock());
    ev(36 * US, 'RC', 'BERT', () => bertText('Internal'),
      'Internal 第 1 窗口：无错误', () => bert.accumulate(1e9, 0));
    ev(44 * US, 'RC', 'BERT', () => bertText('Internal'),
      'Internal 第 2 窗口：无错误 — 只能说明器件自身正常',
      () => bert.accumulate(1e9, 0));

    bertPhase(56 * US, 'Internal · 器件自身异常',
      'Internal 环回无通道参与，注入误码等价于 SerDes / PLL 抖动或 CDR 采样错误');

    at(110 * US, () => {
      sim.beginPhase('lpbk_exit', '结束 Internal Loopback', 'reset');
      lpbk.exit();
      sim.emit({
        layer: 'PHY', row: 'RC.PHY', side: 'RC', dir: '-', type: 'LOOPBACK',
        summary: 'Internal Loopback 测试结束（链路始终保持 L0）',
        detail: '本配置未验证通道；通道验证需另行选择 External Loopback（独立测试）',
        status: 'ok',
      });
    });
    at(122 * US, () => sim.endPhase());

    sim.durationNs = 132 * US;
    return {
      gen,
      width,
      pattern: 'PRBS7',
      mode,
      flitMode: link.flitMode,
      durationNs: sim.durationNs,
      totalSteps: sim.pending,
      rows: sim.rows,
      defaultRow: null,
    };
  }

  // ================= External Loopback（独立测试） =================
  function buildExternal() {
    const pinfo = patternInfo(pattern);

    at(0, () => {
      sim.beginPhase('lpbk_cfg', 'External Loopback 配置（独立测试）', 'loopback',
        '回环点在对端（EP 作为 Loopback Slave）或环回插头，数据经通道往返');
      link.setBoth('L0', 'RC / EP：L0（已训练）', 'External 测试需要链路先训练到 L0');
    });

    ev(6 * US, null, 'LOOPBACK',
      'Internal 与 External 是两套独立配置：顶栏「环回」选择，一次只运行一种',
      'External 由 RC 当 Master、EP 当 Slave，回环路径包含整条通道');

    ev(10 * US, null, 'PATTERN',
      'BERT 可用图案：PRBS7 / PRBS9 / PRBS11 / PRBS15 / PRBS23 / PRBS31',
      '序列越短锁定越快、覆盖的连 0/1 越少；序列越长越能暴露低频损耗与 AC 耦合问题');

    at(16 * US, () => {
      sim.beginPhase('lpbk_ext', 'External Loopback 测试', 'lpbk_ext',
        'RC 发送带 Loopback 位的 TS1，EP 进入 Slave 后经通道回环；使用长序列覆盖通道');
    });

    const loopTs1 = buildOrderedSet('TS1', {
      gen, width, nFts, link: 0, laneNumbers: laneAll, rates, flitMode: link.flitMode, control: 0x4,
    });
    at(20 * US, () => {
      sim.emit({
        layer: 'PHY',
        row: 'RC.PHY',
        side: 'RC',
        dir: 'TX',
        type: 'LOOPBACK',
        summary: 'RC（Loopback Master）发送 TS1：Training Control.Loopback=1',
        detail: '接收端看到连续 2 个 Loopback TS1 后进入 Loopback Slave',
        packet: loopTs1,
        status: 'ok',
        dur_ns: loopTs1.realTimeNs,
      });
    });
    ev(32 * US, 'EP', 'LOOPBACK', 'EP 识别连续 2 个 Loopback TS1，进入 Loopback Slave',
      'Slave 将收到的符号原样回环：回环路径包含 EP 的 RX/TX 与整条通道');
    state(42 * US, 'Loopback', 'RC / EP：进入 Loopback', '链路进入测试环回状态');

    at(46 * US, () => {
      lpbk.enter('external', pattern);
      bert.start(pattern);
    });
    ev(48 * US, 'RC', 'PATTERN',
      () => `BERT 启动：${pattern}（${pinfo.polynomial}，周期 ${pinfo.period} bit）`,
      '长序列覆盖更长的连 0/1 与低频成分，更容易暴露通道损耗与 AC 耦合问题');
    ev(54 * US, 'RC', 'BERT', () => `${pattern} 图案锁定`,
      'Checker 与 LFSR 同步，开始累计比特', () => bert.lock());
    ev(62 * US, 'RC', 'BERT', () => bertText('External'),
      'External 第 1 窗口：无错误（通道损耗 12 dB 仍在裕量内）',
      () => bert.accumulate(1e9, 0));
    ev(72 * US, 'RC', 'BERT', () => bertText('External'),
      'External 第 2 窗口：继续累计', () => bert.accumulate(1e9, 0));

    bertPhase(82 * US, 'External · 通道抖动 / 噪声 / 连接器反射',
      'External 才能暴露通道问题：注入误码等价于 ISI、反射或串扰导致的判决错误');

    at(132 * US, () => {
      sim.beginPhase('lpbk_exit', '结束 External Loopback', 'reset');
      lpbk.exit();
      link.linkUp = false;
      link.setBoth('Detect.Quiet', 'RC / EP：退出 Loopback，返回 Detect',
        'External 测试结束后链路重新进入训练流程');
      sim.emit({
        layer: 'PHY', row: 'RC.PHY', side: 'RC', dir: '-', type: 'LOOPBACK',
        summary: 'External Loopback 测试结束',
        detail: '可通过重新训练回到 L0', status: 'ok',
      });
    });
    at(146 * US, () => sim.endPhase());

    sim.durationNs = 158 * US;
    return {
      gen,
      width,
      pattern,
      mode,
      flitMode: link.flitMode,
      durationNs: sim.durationNs,
      totalSteps: sim.pending,
      rows: sim.rows,
      defaultRow: null,
    };
  }

  return mode === 'internal' ? buildInternal() : buildExternal();
}
