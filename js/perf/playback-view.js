import { eventName } from './event-inspector.js';

const names = { submit: '提交', 'tag-allocated': '分配 Tag', 'completion-arrived': '收到 CplD',
  'mrd-tx-start': 'RTT 起点', 'cpl-rx-end': 'CplD 抵达发起端链路',
  'local-accepted': '本地接受', 'target-visible': '目标可见', done: '完成', block: '资源阻塞' };
const packets = { NP: 'MRd', P: 'MWr', Cpl: 'CplD', read: '本地读', write: '本地写' };
const scale = 10000;

export function createPlayback(get, format, syncTimeline) {
  const picker = get('flow-sample');
  const slider = get('flow-clock');
  const layer = get('flow-layer');
  const play = get('play-flow');
  let renderBoard, trace = [], services = [], markers = [], ticks = [], byTime = new Map();
  let origin = 0, span = 0, position = 0, frame = null, started = null;
  let stepIndex = 0;

  function pause() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    started = null;
    play.textContent = '播放';
  }

  function paint(updateSlider = true) {
    const now = origin + position;
    const current = services.filter(event => event.atNs <= now && now < event.atNs + event.durationNs &&
      (layer.value === 'all' || (layer.value === 'control' ? event.packetClass === 'NP' : event.packetClass !== 'NP')));
    const events = byTime.get(ticks[stepIndex]) ?? [];
    renderBoard?.(current, now, { events, offset: ticks[stepIndex], index: stepIndex + 1, count: ticks.length });
    if (updateSlider) slider.value = span ? Math.round(position / span * scale) : 0;
    get('flow-time').textContent = `${format(position)} / ${format(span)} ns`;
    slider.setAttribute('aria-valuetext', `${format(position)} 纳秒`);
    const transit = current.filter(event => event.node.includes('>'));
    const activity = transit.length ? transit.map(event =>
      `${event.node.replace('>', ' → ')} · ${packets[event.packetClass]} · ${event.bytes} B（线上）`) :
      current.map(event => `${event.node} · ${packets[event.packetClass] ?? '处理'}`);
    get('flow-activity').textContent = activity.length ? [...new Set(activity)].slice(0, 5).join('　|　') :
      position === span ? '样本结束' : '当前层无活动；可能正在等待资源或处理其他流量';
    get('flow-events').textContent = (events.length ? events.slice(0, 4) : markers.filter(event => event.atNs <= now).slice(-3))
      .map(event => `+${format(event.atNs - origin)} ns ${eventName(event)} · ${event.resource}${event.tag == null ? '' : ` / Tag ${event.tag}`}`)
      .join('　|　');
    get('step-flow').disabled = position >= span;
    get('prev-flow').disabled = stepIndex === 0;
  }

  function move(to) {
    position = to;
    stepIndex = Math.max(0, ticks.findLastIndex(time => time <= to));
  }

  function select(value) {
    pause();
    picker.value = value;
    const events = value === 'all' ? trace : trace.filter(event => event.opId === value);
    services = events.filter(event => event.event === 'service' && event.durationNs > 0);
    markers = events.filter(event => names[event.event]);
    origin = events[0]?.atNs ?? 0;
    byTime = new Map();
    for (const event of events) {
      const time = event.atNs - origin;
      if (!byTime.has(time)) byTime.set(time, []);
      byTime.get(time).push(event);
    }
    ticks = [...byTime.keys()];
    span = ticks.at(-1) ?? 0;
    move(0);
    play.disabled = !span;
    paint();
  }

  play.addEventListener('click', () => {
    if (frame !== null) { pause(); return; }
    if (!span) return;
    if (position === span) move(0);
    let initial = position;
    play.textContent = '暂停';
    const tick = time => {
      started ??= time;
      const next = ticks[stepIndex + 1] ?? span;
      const duration = Math.max(160, (next - initial) / span * 8500);
      const progress = Math.min(1, (time - started) / duration);
      if (progress === 1) {
        move(next);
        started = time;
        initial = position;
      } else position = initial + (next - initial) * progress;
      paint();
      if (position >= span) pause();
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  });
  picker.addEventListener('change', () => {
    select(picker.value);
    if (picker.value !== 'all') syncTimeline(picker.value);
  });
  layer.addEventListener('change', () => paint());
  slider.addEventListener('input', () => { pause(); move(Number(slider.value) / scale * span); paint(false); });
  get('step-flow').addEventListener('click', () => {
    pause();
    move(ticks[stepIndex + 1] ?? span);
    paint();
  });
  get('prev-flow').addEventListener('click', () => { pause(); move(ticks[Math.max(0, stepIndex - 1)] ?? 0); paint(); });
  get('reset-flow').addEventListener('click', () => { pause(); move(0); paint(); });
  return {
    pause,
    select,
    refresh: paint,
    snapshot() {
      return { sample: picker.value, origin, atNs: origin + position };
    },
    seek(atNs) {
      pause();
      move(Math.max(0, Math.min(span, atNs - origin)));
      paint();
    },
    load(simulation, board, options) {
      pause();
      renderBoard = board;
      trace = simulation?.trace ?? [];
      picker.replaceChildren(new Option('多笔叠加（含双端）', 'all'), ...options.map(option => option.cloneNode(true)));
      get('playback').hidden = !trace.length;
      select(options[0]?.value ?? 'all');
    },
  };
}
