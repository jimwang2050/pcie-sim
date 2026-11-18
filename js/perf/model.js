export const PERF_SCHEMA = 1;

export const DEFAULTS = Object.freeze({
  gen: 4, lanes: 8, mps: 256, mrrs: 512, rcb: 64, axiBurstBytes: 1024,
  tags: 32, completionBytes: 16384, axiRead: 32, axiWrite: 32,
  dmaOps: 32, dmaBytes: 65536, writeBuffers: 32, targetQueue: 32,
  creditHeaders: 32, creditData: 128, creditReturnNs: 100, propagationNs: 5,
  framingBytes: 8, nfmAvailability: 0.99, cmnBandwidthGBps: 64,
  rcAxiWidthBits: null, rcAxiClockGHz: null, rcBridgeBandwidthGBps: null,
});

const LIMITS = {
  tags: 256, completionBytes: 2 ** 24, axiRead: 4096, axiWrite: 4096,
  dmaOps: 4096, dmaBytes: 2 ** 24, writeBuffers: 4096, targetQueue: 4096,
  creditHeaders: 4096, creditData: 65536, framingBytes: 64,
};

const profiles = {
  CPU: [8, 2, 16], DMA: [20, 2, 64], AXI: [12, 2, 32],
  CMN: [28, 2, 64], CTL: [18, 2, 64], PHY: [12, 1, 128],
  switch: [35, 2, 64], DDR: [95, 0, 32, 24, 12],
  HBM: [90, 0, 64, 48, 6], BAR: [55, 4, 8, 8, 0],
};

function inRange(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

export function rcBridgePreset(gen, lanes) {
  const bitsPerLane = { 4: 32, 5: 32, 6: 64 }[gen];
  if (!bitsPerLane || ![1, 2, 4, 8, 16].includes(lanes)) throw new RangeError('RC Bridge preset');
  const widthBits = bitsPerLane * lanes;
  const clockGHz = 1;
  const interfacePeakGBps = widthBits / 8 * clockGHz;
  return { widthBits, clockGHz, interfacePeakGBps,
    bandwidthGBps: gen === 6 && lanes === 16 ? 64 : interfacePeakGBps };
}

export function configFor(input = {}) {
  const { nodes = {}, p2p = 'direct', source = 'example', ...rest } = input;
  const model = { ...DEFAULTS, ...rest, nodes, p2p, source };
  for (const key of Object.keys(rest)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new RangeError(`Unknown setting: ${key}`);
  }
  for (const [key, max] of Object.entries(LIMITS)) {
    if (!inRange(model[key], key === 'framingBytes' ? 0 : 1, max)) throw new RangeError(key);
  }
  for (const [key, values] of Object.entries({
    gen: [4, 5, 6], lanes: [1, 2, 4, 8, 16], rcb: [64, 128],
    mps: [128, 256, 512, 1024, 2048, 4096], mrrs: [128, 256, 512, 1024, 2048, 4096],
  })) {
    if (!values.includes(model[key])) throw new RangeError(key);
  }
  const rcPreset = rcBridgePreset(model.gen, model.lanes);
  model.rcAxiWidthBits ??= rcPreset.widthBits;
  model.rcAxiClockGHz ??= rcPreset.clockGHz;
  model.rcBridgeBandwidthGBps ??= rcPreset.bandwidthGBps;
  if (!inRange(model.rcAxiWidthBits, 8, 4096) || model.rcAxiWidthBits % 8) throw new RangeError('rcAxiWidthBits');
  if (!Number.isFinite(model.rcAxiClockGHz) || model.rcAxiClockGHz <= 0 || model.rcAxiClockGHz > 16) {
    throw new RangeError('rcAxiClockGHz');
  }
  const rcPeak = model.rcAxiWidthBits / 8 * model.rcAxiClockGHz;
  if (!Number.isFinite(model.rcBridgeBandwidthGBps) || model.rcBridgeBandwidthGBps <= 0
    || model.rcBridgeBandwidthGBps > rcPeak) throw new RangeError('rcBridgeBandwidthGBps');
  if (!inRange(model.axiBurstBytes, 4, 4096) || model.axiBurstBytes % 4) throw new RangeError('axiBurstBytes');
  for (const key of ['creditReturnNs', 'propagationNs']) {
    if (!Number.isFinite(model[key]) || model[key] < 0) throw new RangeError(key);
  }
  if (!Number.isFinite(model.cmnBandwidthGBps) || model.cmnBandwidthGBps <= 0 || model.cmnBandwidthGBps > 4096) {
    throw new RangeError('cmnBandwidthGBps');
  }
  if (!(model.nfmAvailability > 0 && model.nfmAvailability <= 1)) throw new RangeError('nfmAvailability');
  if (!['direct', 'acs-redirect', 'disabled'].includes(p2p)) throw new RangeError('p2p');
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) throw new RangeError('nodes');
  const nodeIds = SCENARIOS.flatMap(scenario => {
    const path = topology(scenario, { p2p: 'direct' });
    return [path.source, path.bridge, path.target, ...path.route, ...path.localCopy];
  });
  for (const id of Object.keys(nodes)) {
    const settings = nodes[id];
    if (!nodeIds.includes(id) || id.includes('>') || !settings
      || typeof settings !== 'object' || Array.isArray(settings)) throw new RangeError(`Invalid node override: ${id}`);
    profile(model, id);
  }
  return model;
}

export function linkCapacity(model) {
  const rawGBps = { 4: 16, 5: 32, 6: 64 }[model.gen] * model.lanes / 8;
  return { rawGBps, budgetGBps: rawGBps * (model.gen === 6 ? 236 / 256 : 128 / 130 * model.nfmAvailability),
    accounting: model.gen === 6 ? 'optimistic TLP area; no FM packing or control costs' : 'NFM encoded stream after availability budget' };
}

const routeEP = ['epA.CTL', 'epA.PHY', 'epA>rc', 'rc.PHY', 'rc.CTL', 'rc.AXI', 'host.CMN'];
const p2pForward = ['epA.CTL', 'epA.PHY', 'epA>sw', 'swA.PHY', 'sw.fabric',
  'swB.PHY', 'sw>epB', 'epB.PHY', 'epB.CTL'];

function reverse(path) {
  return path.slice().reverse().map(id => id.includes('>') ? id.split('>').reverse().join('>') : id);
}

export const SCENARIOS = Object.freeze(['ep-ddr', 'cpu-bar', 'host-dma', 'p2p', 'p2p-reverse']);

export function topology(scenario, model) {
  if (!SCENARIOS.includes(scenario)) throw new RangeError(`Unsupported path: ${scenario}`);
  if (scenario.startsWith('p2p') && model.p2p !== 'direct') {
    throw new RangeError(`P2P unavailable: ${model.p2p}; P1 does not assume Root forwarding`);
  }
  const map = {
    'ep-ddr': ['epA', 'epA.DMA', 'epA.AXI', routeEP, 'host.DDR'],
    'cpu-bar': ['cpu', 'host.CPU', 'cpu.AXI', reverse(routeEP), 'epA.BAR'],
    'host-dma': ['hostDMA', 'host.DMA', 'hostDMA.AXI', reverse(routeEP), 'epA.HBM'],
    p2p: ['epA', 'epA.DMA', 'epA.AXI', p2pForward, 'epB.HBM'],
    'p2p-reverse': ['epB', 'epB.DMA', 'epB.AXI', reverse(p2pForward), 'epA.HBM'],
  };
  const [requester, source, bridge, baseRoute, target] = map[scenario];
  const targetBridge = target.startsWith('ep') ? [target.replace(/\.[^.]+$/, '.AXI')] : [];
  const route = [...baseRoute, ...targetBridge];
  return { requester, source, bridge, route, returnRoute: reverse(route), target,
    localCopy: scenario === 'host-dma' ? ['host.CMN', 'host.DDR'] : [] };
}

export function profile(model, id) {
  if (id.includes('>')) return { latencyNs: model.propagationNs, iiNs: 0, bandwidth: linkCapacity(model).budgetGBps };
  const kind = id === 'sw.fabric' ? 'switch' : id.split('.').at(-1);
  const [latencyNs, iiNs, bandwidth, writeGBps = bandwidth, turnaroundNs = 0] = profiles[kind];
  const nodeOverride = model.nodes[id] ?? {};
  const widthBits = nodeOverride.widthBits ?? (id === 'rc.AXI' ? model.rcAxiWidthBits : undefined);
  const clockGHz = nodeOverride.clockGHz ?? (id === 'rc.AXI' ? model.rcAxiClockGHz : undefined);
  const { widthBits: ignoredWidth, clockGHz: ignoredClock, ...overrides } = nodeOverride;
  let capacity = kind === 'CMN' ? model.cmnBandwidthGBps : bandwidth;
  let interfacePeakGBps;
  if (widthBits !== undefined || clockGHz !== undefined) {
    if (kind !== 'AXI' || !inRange(widthBits, 8, 4096) || widthBits % 8 || !Number.isFinite(clockGHz) || clockGHz <= 0) {
      throw new RangeError(`${id}: AXI widthBits and clockGHz must be supplied together`);
    }
    interfacePeakGBps = widthBits / 8 * clockGHz;
    capacity = id === 'rc.AXI' ? model.rcBridgeBandwidthGBps : interfacePeakGBps;
  }
  const settings = { latencyNs, iiNs, bandwidth: capacity, writeGBps: kind === 'AXI' ? capacity : writeGBps,
    turnaroundNs, ...overrides };
  if (id === 'rc.AXI' && interfacePeakGBps !== undefined
    && (settings.bandwidth > interfacePeakGBps || settings.writeGBps > interfacePeakGBps)) {
    throw new RangeError(`${id}.bandwidth exceeds AXI physical peak`);
  }
  for (const [key, value] of Object.entries(settings)) {
    if (!['latencyNs', 'iiNs', 'bandwidth', 'writeGBps', 'turnaroundNs'].includes(key)
      || !Number.isFinite(value) || value < (['bandwidth', 'writeGBps'].includes(key) ? Number.MIN_VALUE : 0)) {
      throw new RangeError(`${id}.${key}`);
    }
  }
  return { ...settings, ...(interfacePeakGBps === undefined ? {} : { widthBits, clockGHz, interfacePeakGBps }) };
}

export function split(address, bytes, maxBytes, boundary = 4096) {
  const parts = [];
  while (bytes > 0) {
    const size = Math.min(bytes, maxBytes, boundary - address % boundary);
    parts.push({ address, bytes: size });
    bytes -= size;
    address += size;
  }
  return parts;
}

export function completions(part, model) {
  const pieces = [];
  let { address, bytes } = part;
  while (bytes) {
    const limit = address + model.mps;
    const size = bytes <= model.mps ? bytes : limit - limit % model.rcb - address;
    pieces.push(size);
    address += size;
    bytes -= size;
  }
  return pieces;
}

export function packetBytes(model, kind, payload) {
  const header = kind === 'Cpl' ? 12 : 16;
  return payload + header + (model.gen === 6 ? 0 : model.framingBytes);
}

export function flowSpecs(flows) {
  if (!Array.isArray(flows) || !flows.length || flows.length > 16) throw new RangeError('flows');
  return flows.map((input, index) => {
    const flow = { scenario: 'ep-ddr', readPct: 50, readBytes: 512, writeBytes: 512, count: 256,
      startNs: 0, intervalNs: 0, address: 0, readOffset: 0, writeOffset: 2 ** 28,
      batch: 1, order: 'independent', ...input, id: `flow${index + 1}` };
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(flow, key) || !['scenario','readPct','readBytes','writeBytes','count','startNs',
        'intervalNs','address','readOffset','writeOffset','batch','order'].includes(key)) throw new RangeError(`Unknown flow setting: ${key}`);
    }
    if (flow.scenario === 'cpu-bar') {
      flow.readBytes = input.readBytes ?? 4;
      flow.writeBytes = input.writeBytes ?? 4;
    }
    for (const key of ['readBytes', 'writeBytes']) {
      if (!inRange(flow[key], 4, flow.scenario === 'cpu-bar' ? 8 : 65536) || flow[key] % 4) throw new RangeError(key);
    }
    for (const key of ['address', 'readOffset', 'writeOffset']) {
      if (!inRange(flow[key], 0, 2 ** 48) || flow[key] % 4) throw new RangeError(key);
    }
    if (!inRange(flow.readPct, 0, 100) || !inRange(flow.count, 1, 100000)
      || !inRange(flow.batch, 1, flow.count)) throw new RangeError('readPct/count/batch');
    if (!['independent', 'visible-serial'].includes(flow.order)) throw new RangeError('order');
    for (const key of ['startNs', 'intervalNs']) {
      if (!Number.isFinite(flow[key]) || flow[key] < 0) throw new RangeError(key);
    }
    return flow;
  });
}

export function* operations(flow) {
  const issued = { read: 0, write: 0 };
  let kind = 'read';
  for (let seq = 0; seq < flow.count; seq++) {
    if (seq % flow.batch === 0) {
      kind = flow.readPct === 0 || (flow.readPct !== 100 && seq && issued.read * 100 >
        (issued.read + issued.write) * flow.readPct) ? 'write' : 'read';
    }
    const bytes = flow[`${kind}Bytes`];
    const address = flow.address + flow[`${kind}Offset`] + issued[kind];
    issued[kind] += bytes;
    yield { kind, address, bytes, seq, id: `${flow.id}:${seq}`, at: flow.startNs + seq * flow.intervalNs };
  }
}
