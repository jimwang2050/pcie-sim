/**
 * 仿真外壳：虚拟时钟、事件流、阶段划分与订阅通知。
 * 与 DOM 无关，可在 node 中直接驱动。
 */
import { Scheduler } from './scheduler.js';
import { LinkModel } from './link.js';
import { ConfigSpace } from './config.js';
import { PhyModel } from './phy.js';
import { BertModel } from './bert.js';
import { FlowControl } from './fc.js';
import { Memory } from './memory.js';
import { MsiModel } from './msi.js';
import { AerModel } from './aer.js';
import { PmModel } from './pm.js';
import { DpcModel } from './dpc.js';
import { AtsModel } from './ats.js';
import { LoopbackModel } from './loopback.js';
import { HotPlugModel } from './hotplug.js';
import { FlitStats } from './flit.js';

const MAX_HISTORY = 200;

function cloneValue(v) {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (Array.isArray(v)) return v.map(cloneValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = cloneValue(v[k]);
    return out;
  }
  return v;
}

function freezeValue(v) {
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) {
    for (const child of Object.values(v)) freezeValue(child);
    Object.freeze(v);
  }
  return v;
}

export class Sim {
  constructor() {
    this.scheduler = new Scheduler();
    this.history = [];
    this.events = [];
    this.phases = [];
    this.currentPhase = null;
    this.link = new LinkModel(this);
    this.config = new ConfigSpace();
    this.phy = new PhyModel();
    this.bert = new BertModel();
    this.fc = new FlowControl();
    this.mem = new Memory();
    this.msi = new MsiModel();
    this.aer = new AerModel();
    this.pm = new PmModel();
    this.dpc = new DpcModel();
    this.ats = new AtsModel();
    this.loopback = new LoopbackModel();
    this.hotplug = new HotPlugModel();
    this.flit = new FlitStats();
    this.durationNs = 1;
    this.listeners = new Set();
    this.finished = false;
    this.scenarioState = {};
    this.stopReason = null;
    this.rows = [
      { key: 'STATE', label: 'LTSSM 状态' },
      { key: 'RC.PHY', label: 'RC · PHY' },
      { key: 'EP.PHY', label: 'EP · PHY' },
    ];
  }

  reset(config = {}) {
    this.scheduler.clear();
    this.events = [];
    this.phases = [];
    this.currentPhase = null;
    this.durationNs = 1;
    this.finished = false;
    this.scenarioState = {};
    this.stopReason = null;
    this.link.configure(config);
    this.link.reset();
    this.config = new ConfigSpace();
    this.phy.reset(config.gen ?? 3, config.width ?? 8);
    this.bert.reset();
    this.fc.reset();
    this.mem.reset();
    this.msi.reset();
    this.aer.reset();
    this.pm.reset();
    this.dpc.reset();
    this.ats.reset();
    this.loopback.reset();
    this.hotplug.reset();
    this.flit.reset();
    this.history = [];
  }

  get clock() {
    return this.scheduler.time;
  }

  get pending() {
    return this.scheduler.pending;
  }

  snapshot() {
    return {
      time: this.scheduler.time,
      seq: this.scheduler.seq,
      queue: this.scheduler.items.slice(),
      eventsLength: this.events.length,
      phases: cloneValue(this.phases),
      currentPhaseIndex: this.phases.indexOf(this.currentPhase),
      durationNs: this.durationNs,
      finished: this.finished,
      scenarioState: cloneValue(this.scenarioState),
      stopReason: this.stopReason,
      rows: cloneValue(this.rows),
      link: {
        gen: this.link.gen,
        width: this.link.width,
        targetGen: this.link.targetGen,
        linkUp: this.link.linkUp,
        flitMode: this.link.flitMode,
        modeRequested: this.link.modeRequested,
        modeNote: this.link.modeNote,
        negotiated: cloneValue(this.link.negotiated),
        ports: cloneValue(this.link.ports),
      },
      config: {
        vendorId: this.config.vendorId,
        deviceId: this.config.deviceId,
        classCode: this.config.classCode,
        bars: cloneValue(this.config.bars),
        mem: new Uint8Array(this.config.mem),
      },
      phy: cloneValue({
        gen: this.phy.gen,
        width: this.phy.width,
        activeGen: this.phy.activeGen,
        rateGts: this.phy.rateGts,
        refClk: this.phy.refClk,
        pll: this.phy.pll,
        cdr: this.phy.cdr,
        eq: this.phy.eq,
        channel: this.phy.channel,
        rxEq: this.phy.rxEq,
        fec: this.phy.fec,
        metrics: this.phy.metrics,
      }),
      bert: cloneValue({
        enabled: this.bert.enabled,
        pattern: this.bert.pattern,
        polynomial: this.bert.polynomial,
        locked: this.bert.locked,
        bits: this.bert.bits,
        errors: this.bert.errors,
        ber: this.bert.ber,
        targetBer: this.bert.targetBer,
        history: this.bert.history,
        injections: this.bert.injections,
      }),
      fc: cloneValue({
        enabled: this.fc.enabled,
        initDone: this.fc.initDone,
        limits: this.fc.limits,
        available: this.fc.available,
      }),
      memBytes: new Uint8Array(this.mem.bytes),
      msi: cloneValue({
        msiEnabled: this.msi.msiEnabled,
        msixEnabled: this.msi.msixEnabled,
        msiAddress: this.msi.msiAddress,
        msiData: this.msi.msiData,
        vectorCount: this.msi.vectorCount,
        masked: this.msi.masked,
        msixTable: this.msi.msixTable,
        lastVector: this.msi.lastVector,
        interrupts: this.msi.interrupts,
        suppressed: this.msi.suppressed,
      }),
      aer: cloneValue({
        enabled: this.aer.enabled,
        correctable: this.aer.correctable,
        nonfatal: this.aer.nonfatal,
        fatal: this.aer.fatal,
        log: this.aer.log,
      }),
      pm: cloneValue({
        enabled: this.pm.enabled,
        dstate: this.pm.dstate,
        pstate: this.pm.pstate,
        pmeEn: this.pm.pmeEn,
        pmeStatus: this.pm.pmeStatus,
        noSoftReset: this.pm.noSoftReset,
        auxPower: this.pm.auxPower,
        linkState: this.pm.linkState,
        l1Sub: this.pm.l1Sub,
      }),
      dpc: cloneValue(this.dpc.snapshot()),
      ats: cloneValue(this.ats.snapshot()),
      loopback: cloneValue(this.loopback.snapshot()),
      hotplug: cloneValue(this.hotplug.snapshot()),
      flit: cloneValue({
        enabled: this.flit.enabled,
        lastSeq: this.flit.lastSeq,
        corrected: this.flit.corrected,
        uncorrectable: this.flit.uncorrectable,
        retries: this.flit.retries,
        crcFails: this.flit.crcFails,
        status: this.flit.status,
      }),
    };
  }

  restore(s) {
    this.scheduler.items = s.queue.slice();
    this.scheduler.time = s.time;
    this.scheduler.seq = s.seq;
    this.events.length = s.eventsLength;
    this.phases = cloneValue(s.phases);
    this.currentPhase = s.currentPhaseIndex >= 0
      ? (this.phases[s.currentPhaseIndex] || null)
      : null;
    this.durationNs = s.durationNs;
    this.finished = s.finished;
    this.scenarioState = cloneValue(s.scenarioState);
    this.stopReason = s.stopReason;
    this.rows = cloneValue(s.rows);

    Object.assign(this.link, {
      gen: s.link.gen,
      width: s.link.width,
      targetGen: s.link.targetGen,
      linkUp: s.link.linkUp,
      flitMode: s.link.flitMode,
      modeRequested: s.link.modeRequested,
      modeNote: s.link.modeNote,
      negotiated: cloneValue(s.link.negotiated),
      ports: cloneValue(s.link.ports),
    });

    Object.assign(this.config, {
      vendorId: s.config.vendorId,
      deviceId: s.config.deviceId,
      classCode: s.config.classCode,
      bars: cloneValue(s.config.bars),
      mem: new Uint8Array(s.config.mem),
    });

    Object.assign(this.phy, cloneValue(s.phy));
    Object.assign(this.bert, cloneValue(s.bert));
    Object.assign(this.fc, cloneValue(s.fc));
    this.mem.bytes = new Uint8Array(s.memBytes);
    Object.assign(this.msi, cloneValue(s.msi));
    Object.assign(this.aer, cloneValue(s.aer));
    Object.assign(this.pm, cloneValue(s.pm));
    Object.assign(this.dpc, cloneValue(s.dpc));
    Object.assign(this.ats, cloneValue(s.ats));
    Object.assign(this.loopback, cloneValue(s.loopback));
    Object.assign(this.hotplug, cloneValue(s.hotplug));
    Object.assign(this.flit, cloneValue(s.flit));
  }

  pushHistory() {
    if (this.history.length >= MAX_HISTORY) this.history.shift();
    this.history.push(this.snapshot());
  }

  stepBack() {
    if (!this.history.length) return false;
    const snap = this.history.pop();
    this.restore(snap);
    this.emitSignal('step');
    return true;
  }

  at(t, fn) {
    return this.scheduler.at(t, fn);
  }

  after(delayNs, fn) {
    return this.scheduler.after(delayNs, fn);
  }

  beginPhase(key, label, kind, detail = '') {
    if (this.currentPhase && this.currentPhase.end_ns === null) {
      this.currentPhase.end_ns = this.clock;
    }
    const phase = { key, label, kind, detail, start_ns: this.clock, end_ns: null, events: 0 };
    this.phases.push(phase);
    this.currentPhase = phase;
  }

  endPhase() {
    if (this.currentPhase && this.currentPhase.end_ns === null) {
      this.currentPhase.end_ns = this.clock;
    }
    this.currentPhase = null;
  }

  emit(ev) {
    const event = {
      id: this.events.length,
      t_ns: this.clock,
      dur_ns: 0,
      layer: 'STATE',
      row: 'STATE',
      side: null,
      dir: '-',
      type: 'STATE',
      summary: '',
      status: 'ok',
      packet: null,
      ...ev,
    };
    if (event.t_ns < 0) event.t_ns = 0;
    event.phase = this.currentPhase ? this.currentPhase.key : null;
    freezeValue(event.packet = cloneValue(event.packet));
    freezeValue(event);
    this.events.push(event);
    if (this.currentPhase) this.currentPhase.events += 1;
    this.emitSignal('event', event);
    return event;
  }

  stepOnce() {
    if (!this.scheduler.pending) {
      this.finished = true;
      return false;
    }
    this.pushHistory();
    this.scheduler.step();
    if (!this.scheduler.pending) this.finished = true;
    this.emitSignal('step');
    return true;
  }

  /** 跑到队列耗尽（测试与静态导出用）。 */
  runToEnd(limit = 100000) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('步数上限必须为正整数');
    let n = 0;
    while (this.scheduler.pending && n < limit) {
      this.stepOnce();
      n += 1;
    }
    this.stopReason = this.scheduler.pending ? 'step-limit' : 'queue-empty';
    return n;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emitSignal(type, payload = null) {
    for (const fn of this.listeners) fn(type, payload);
  }

  finalize() {
    if (this.currentPhase && this.currentPhase.end_ns === null) this.currentPhase.end_ns = this.clock;
    if (this.durationNs < this.clock) this.durationNs = this.clock;
  }
}
