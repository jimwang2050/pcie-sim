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
  const speed = get('flow-speed');
  const play = get('play-flow');
  let renderBoard, trace = [], services = [], markers = [], ticks = [], byTime = new Map();
  let origin = 0, span = 0, position = 0, frame = null;
  let stepIndex = 0, segments = [], startPosition = 0, baseElapsed = 0, lastFrame = null;

  function pause() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    lastFrame = null;
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

  function positionAt(from, elapsed) {
    let remaining = elapsed;
    let index = segments.findIndex(segment => segment.to > from);
    if (index < 0) return span;
    const first = segments[index];
    remaining += Math.min(1, (from - first.from) / (first.to - first.from)) * first.duration;
    for (; index < segments.length; index++) {
      const segment = segments[index];
      if (remaining < segment.duration) {
        return segment.from + (segment.to - segment.from) * (remaining / segment.duration);
      }
      remaining -= segment.duration;
    }
    return span;
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
    segments = [];
    for (let index = 0; index < ticks.length - 1; index++) {
      const from = ticks[index];
      const to = ticks[index + 1];
      segments.push({ from, to, duration: Math.max(160, (to - from) / (span || 1) * 8500) });
    }
    move(0);
    play.disabled = !span;
    paint();
  }

  play.addEventListener('click', () => {
    if (frame !== null) { pause(); return; }
    if (!span) return;
    if (position === span) move(0);
    startPosition = position;
    baseElapsed = 0;
    lastFrame = null;
    play.textContent = '暂停';
    const tick = time => {
      if (lastFrame === null) lastFrame = time;
      const slow = Number(speed?.value) || 1;
      // 选择值表示慢放倍数：1× 原速，2× 放慢到 1/2，32× 放慢到 1/32。
      baseElapsed += Math.max(0, time - lastFrame) / slow;
      lastFrame = time;
      position = positionAt(startPosition, baseElapsed);
      move(position);
      paint();
      if (position >= span) { pause(); return; }
      frame = requestAnimationFrame(tick);
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
