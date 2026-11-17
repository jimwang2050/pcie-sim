/**
 * 场景：上电复位 → 链路训练 → L0（Gen1–Gen5）。
 *
 * 时间轴按 1:100 压缩，便于在几百微秒内观察完整训练过程；
 * 界面上标注了对应的规范计时（Detect 12 ms 等）。
 */
import {
  RATE_BY_GEN,
  ratesBitmap,
  buildOrderedSet,
  orderedSetTimeNs,
} from '../core/packet.js';
import { buildFlit, flitTimeNs } from '../core/flit.js';

const US = 1000;
const DETECT_QUIET = 120 * US;
const DETECT_ACTIVE = 60 * US;

export function buildLinkTraining(sim, opts = {}) {
  const gen = opts.gen ?? 3;
  const width = opts.width ?? 8;
  const mode = opts.mode ?? 'auto';
  const link = sim.link;

  link.configure({ gen, width, mode });
  link.reset();
  sim.phy.reset(gen, width);
  sim.phy.setOperatingRate(1);

  const flitMode = link.flitMode;

  sim.rows = [
    { key: 'STATE', label: 'LTSSM 状态' },
    { key: 'RC.PHY', label: 'RC · PHY' },
    { key: 'EP.PHY', label: 'EP · PHY' },
  ];

  const nFts = gen <= 2 ? 4 : 12;
  const supportedRates = ratesBitmap(gen);
  const osNs = orderedSetTimeNs(gen, width);
  const laneAll = Array.from({ length: width }, (_, i) => i);
  const lanePad = Array.from({ length: width }, () => null);

  let cur = 0;
  const at = (t, fn) => sim.at(t, fn);

  sim.beginPhase(
    'detect',
    'Detect 检测',
    'link',
    '复位释放后进入 Detect，电气检测链路远端是否存在接收器',
  );

  function send(side, kind, params, label, gap = 10 * US) {
    const peer = side === 'RC' ? 'EP' : 'RC';
    const packet = buildOrderedSet(kind, {
      gen,
      width,
      nFts,
      link: params.link ?? 0,
      linkPAD: params.linkPAD ?? false,
      laneNumbers: params.laneNumbers ?? laneAll,
      rates: supportedRates,
      speedChange: params.speedChange ?? false,
      flitMode,
    });
    const txT = cur;
    at(txT, () => {
      link.bump(side, kind);
      sim.emit({
        layer: 'PHY',
        row: `${side}.PHY`,
        side,
        dir: 'TX',
        type: kind,
        summary: `${side} → ${peer} 发送 ${kind}（${label}）`,
        packet,
        dur_ns: osNs,
        status: 'ok',
      });
    });
    // 只画发送侧方框；接收在事件摘要中体现，避免同刻收发重叠。
    cur = txT + osNs + gap;
  }

  function emitEI(side, summary) {
    at(cur, () => {
      sim.emit({
        layer: 'PHY',
        row: `${side}.PHY`,
        side,
        dir: 'TX',
        type: 'EI',
        summary,
        dur_ns: 0,
        status: 'idle',
      });
    });
  }

  // ---------- Detect ----------
  at(0, () => {
    sim.phy.stabilizeRefClk();
    sim.phy.lockPll();
    link.setBoth('Detect.Quiet', 'RC / EP：进入 Detect.Quiet', '规范计时 12 ms，演示按 1:100 压缩为 120 µs');
  });
  emitEI('RC', 'RC 发送端处于电气空闲（Electrical Idle）');
  emitEI('EP', 'EP 发送端处于电气空闲（Electrical Idle）');

  cur = DETECT_QUIET;
  at(cur, () => {
    link.setBoth('Detect.Active', 'RC / EP：进入 Detect.Active，发送 Receiver Detect 脉冲', '在差分对上施加检测脉冲，判断远端 50Ω 终端');
  });
  at(cur + 4 * US, () => {
    sim.emit({
      layer: 'PHY',
      row: 'RC.PHY',
      side: 'RC',
      dir: 'TX',
      type: 'DETECT',
      summary: 'RC 发送 Receiver Detect 脉冲',
      status: 'ok',
      dur_ns: 0,
    });
    sim.emit({
      layer: 'PHY',
      row: 'EP.PHY',
      side: 'EP',
      dir: 'TX',
      type: 'DETECT',
      summary: 'EP 发送 Receiver Detect 脉冲',
      status: 'ok',
      dur_ns: 0,
    });
  });

  cur += DETECT_ACTIVE;
  at(cur, () => {
    link.ports.RC.detected = true;
    link.ports.EP.detected = true;
    sim.phy.cdrFreqLock();
    sim.phy.cdrPhaseLock();
    sim.beginPhase('polling', 'Polling 轮询', 'link', '交换 TS1/TS2，建立位锁与符号/块锁');
    link.setBoth('Polling.Active', 'RC / EP：检测到远端接收器，进入 Polling.Active', '双方开始以 2.5 GT/s 发送 TS1');
  });

  // ---------- Polling.Active：3 轮 TS1（Link/Lane 均为 PAD） ----------
  cur += 8 * US;
  for (let round = 1; round <= 3; round += 1) {
    send('RC', 'TS1', { linkPAD: true, laneNumbers: lanePad }, `Polling.Active 第 ${round} 轮`);
    send('EP', 'TS1', { linkPAD: true, laneNumbers: lanePad }, `Polling.Active 第 ${round} 轮`);
  }

  // ---------- Polling.Configuration：TS2（Link/Lane 仍为 PAD） ----------
  cur += 6 * US;
  at(cur, () => {
    sim.phy.cdrBitLock();
    link.setBoth('Polling.Configuration', 'RC / EP：进入 Polling.Configuration', '收到足够 TS1 后改发 TS2 确认');
  });
  cur += 6 * US;
  send('RC', 'TS2', { linkPAD: true, laneNumbers: lanePad }, 'Polling.Configuration');
  send('EP', 'TS2', { linkPAD: true, laneNumbers: lanePad }, 'Polling.Configuration');

  // ---------- Configuration ----------
  cur += 10 * US;
  at(cur, () => {
    sim.beginPhase('config', 'Configuration 配置', 'link', '协商链路宽度、通道编号与链路编号');
    link.setBoth('Configuration.Linkwidth.Start', 'RC / EP：进入 Configuration.Linkwidth.Start', '上游端口先以 PAD 发起，下游端口给出 Link Number');
  });

  cur += 6 * US;
  send('EP', 'TS1', { linkPAD: true, laneNumbers: lanePad }, 'Linkwidth.Start：上游端口初始 Link/Lane=PAD');
  send('RC', 'TS1', { link: 0, laneNumbers: lanePad }, 'Linkwidth.Start：下游端口 Link=0，Lane=PAD');
  send('EP', 'TS1', { link: 0, laneNumbers: lanePad }, 'Linkwidth.Start：上游端口回应相同 Link=0');

  cur += 8 * US;
  at(cur, () => {
    link.setBoth('Configuration.Linkwidth.Accept', 'RC / EP：进入 Configuration.Linkwidth.Accept', '双方接受链路宽度提议');
  });
  cur += 6 * US;
  send('EP', 'TS2', { link: 0, laneNumbers: lanePad }, 'Linkwidth.Accept');
  send('RC', 'TS2', { link: 0, laneNumbers: lanePad }, 'Linkwidth.Accept');

  cur += 8 * US;
  at(cur, () => {
    link.setLaneNumbers(laneAll);
    link.setBoth('Configuration.Lanenum.Wait', 'RC / EP：进入 Configuration.Lanenum.Wait', `分配 Lane Number 0..${width - 1}`);
  });
  cur += 6 * US;
  send('EP', 'TS1', { link: 0, laneNumbers: laneAll }, 'Lanenum.Wait：逐 Lane 分配编号');
  send('RC', 'TS1', { link: 0, laneNumbers: laneAll }, 'Lanenum.Wait：逐 Lane 分配编号');

  cur += 8 * US;
  at(cur, () => {
    link.setBoth('Configuration.Lanenum.Accept', 'RC / EP：进入 Configuration.Lanenum.Accept', '双方确认通道编号');
  });
  cur += 6 * US;
  send('EP', 'TS1', { link: 0, laneNumbers: laneAll }, 'Lanenum.Accept');
  send('RC', 'TS1', { link: 0, laneNumbers: laneAll }, 'Lanenum.Accept');

  cur += 8 * US;
  at(cur, () => {
    link.setBoth('Configuration.Idle', 'RC / EP：进入 Configuration.Idle', '发送 TS2 作为进入 L0 前的最后握手');
  });
  cur += 6 * US;
  send('EP', 'TS2', { link: 0, laneNumbers: laneAll }, 'Configuration.Idle');
  send('RC', 'TS2', { link: 0, laneNumbers: laneAll }, 'Configuration.Idle');

  // ---------- 数据流模式协商 ----------
  cur += 4 * US;
  at(cur, () => {
    sim.emit({
      layer: 'PHY',
      row: 'RC.PHY',
      side: 'RC',
      dir: '-',
      type: 'MODE',
      summary: flitMode
        ? 'Flit Mode 协商：双方 Flit Mode Supported=1 → Flit Mode（256B Flit）'
        : 'Flit Mode 协商：未达成 → Non-Flit Mode（TLP/DLLP 独立成帧）',
      detail: flitMode
        ? (gen === 6
          ? 'Gen6 在 64.0 GT/s 下强制使用 Flit 模式；TS1/TS2 的 Data Rate Identifier bit0 = 1。'
          : '两个端口均支持 Flit 模式，链路在 L0 后按 256 字节 Flit 传输。')
        : '至少一方 Flit Mode Supported=0，链路保持 Non-Flit 模式：TLP 以 STP/END 成帧，DLLP 独立传输。',
      status: 'ok',
    });
  });

  cur += 10 * US;

  if (gen === 1) {
    at(cur, () => {
      link.linkUp = true;
      link.setRate(1);
      link.negotiated = { gen: 1, width };
      sim.phy.setOperatingRate(1);
      sim.phy.setEqPhase(0, 0);
      sim.beginPhase('l0', 'L0 正常工作', 'l0', '链路以 2.5 GT/s 完成训练');
      link.setBoth('L0', `RC / EP：进入 L0（${RATE_BY_GEN[1]}，x${width}）`, '链路训练完成，可交换 TLP/DLLP');
    });
  } else {
    // 先在 2.5 GT/s 进入 L0，再通过 Recovery 变速
    at(cur, () => {
      sim.phy.setOperatingRate(1);
      link.setBoth('L0', 'RC / EP：进入 L0（2.5 GT/s 临时状态）', '复位后总是先以 2.5 GT/s 完成基础训练');
    });

    cur += 12 * US;
    at(cur, () => {
      sim.beginPhase('recovery', 'Recovery 变速', 'recovery', `从 2.5 GT/s 切换到 ${RATE_BY_GEN[gen]}`);
      link.setBoth('Recovery.RcvrLock', 'RC / EP：进入 Recovery.RcvrLock', '在 TS1 中置 Speed Change 位并重新锁定');
    });
    cur += 6 * US;
    send('RC', 'TS1', { link: 0, laneNumbers: laneAll, speedChange: true }, `RcvrLock：请求变速到 ${RATE_BY_GEN[gen]}`);
    send('EP', 'TS1', { link: 0, laneNumbers: laneAll, speedChange: true }, `RcvrLock：请求变速到 ${RATE_BY_GEN[gen]}`);

    cur += 8 * US;
    at(cur, () => {
      link.setBoth('Recovery.Speed', 'RC / EP：进入 Recovery.Speed', 'PLL 重新锁定到目标速率，链路短暂静默');
      sim.emit({
        layer: 'PHY',
        row: 'RC.PHY',
        side: 'RC',
        dir: '-',
        type: 'SPEED',
        summary: `RC 速率切换：PLL 锁定到 ${RATE_BY_GEN[gen]}`,
        status: 'ok',
      });
      sim.emit({
        layer: 'PHY',
        row: 'EP.PHY',
        side: 'EP',
        dir: '-',
        type: 'SPEED',
        summary: `EP 速率切换：PLL 锁定到 ${RATE_BY_GEN[gen]}`,
        status: 'ok',
      });
    });

    cur += 24 * US;
    at(cur, () => {
      link.setBoth('Recovery.RcvrCfg', 'RC / EP：进入 Recovery.RcvrCfg', '以目标速率恢复通道对齐与配置信息');
    });
    cur += 6 * US;
    send('RC', 'TS2', { link: 0, laneNumbers: laneAll }, 'RcvrCfg');
    send('EP', 'TS2', { link: 0, laneNumbers: laneAll }, 'RcvrCfg');

    cur += 8 * US;
    at(cur, () => {
      link.setBoth('Recovery.Idle', 'RC / EP：进入 Recovery.Idle', '变速完成，准备回到 L0');
    });
    cur += 6 * US;
    send('RC', 'TS2', { link: 0, laneNumbers: laneAll }, 'Recovery.Idle');
    send('EP', 'TS2', { link: 0, laneNumbers: laneAll }, 'Recovery.Idle');

    cur += 10 * US;
    at(cur, () => {
      link.linkUp = true;
      link.setRate(gen);
      link.negotiated = { gen, width };
      sim.phy.setOperatingRate(gen);
      sim.phy.setEqPhase(gen >= 3 ? 3 : 0, gen >= 3 ? 10 : 0);
      sim.beginPhase('l0', 'L0 正常工作', 'l0', `链路以 ${RATE_BY_GEN[gen]} × x${width} 工作`);
      link.setBoth('L0', `RC / EP：进入 L0（${RATE_BY_GEN[gen]}，x${width}）`, '链路训练完成，可交换 TLP/DLLP');
    });
  }

  // ---------- L0 数据流 ----------
  cur += 20 * US;
  if (flitMode) {
    const flitNs = flitTimeNs(gen, width);
    const f0 = buildFlit({ seq: 0, gen, width, payload: 'mw' });
    at(cur, () => {
      sim.emit({
        layer: 'PHY',
        row: 'RC.PHY',
        side: 'RC',
        dir: 'TX',
        type: 'FLIT',
        summary: `RC → EP 发送 FLIT #0（256B，承载 MWr TLP）`,
        packet: f0,
        dur_ns: flitNs,
        status: 'ok',
      });
    });
    cur += flitNs + 14 * US;

    const f1 = buildFlit({ seq: 1, gen, width, payload: 'idle' });
    at(cur, () => {
      sim.emit({
        layer: 'PHY',
        row: 'EP.PHY',
        side: 'EP',
        dir: 'TX',
        type: 'FLIT',
        summary: 'EP → RC 发送 FLIT #1（256B，IDLE 负载）',
        packet: f1,
        dur_ns: flitNs,
        status: 'ok',
      });
    });
    cur += flitNs + 10 * US;
  } else {
    send('RC', 'SKP', { link: 0, laneNumbers: laneAll }, 'L0 空闲：周期性发送 SKP OS', 10 * US);
    send('EP', 'SKP', { link: 0, laneNumbers: laneAll }, 'L0 空闲：周期性发送 SKP OS', 8 * US);
  }

  at(cur, () => {
    sim.endPhase();
  });

  sim.durationNs = cur * 1.04;
  return {
    gen,
    width,
    mode,
    flitMode,
    durationNs: sim.durationNs,
    totalSteps: sim.pending,
    rows: sim.rows,
  };
}
