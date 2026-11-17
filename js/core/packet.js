/**
 * 包与线码模型（M1 只覆盖有序集 OS；TLP/DLLP 在 M2 扩展）。
 *
 * 说明：这里的“有序集字节”是逻辑视图，按 16 符号块展示，
 * 便于在界面上统一呈现 TS1/TS2/EIEOS/SKP 的字段。
 *
 * Symbol 4 的 Data Rate Identifier 编码（教学简化）：
 *   bit0=Flit Mode Supported, bit1-6=2.5/5.0/8.0/16.0/32.0/64.0 GT/s 支持,
 *   bit7=Speed Change（仅 Recovery.RcvrLock 置 1）。
 *   规范中 64 GT/s 在 Flit Mode 下使用专用编码 1 0111b，这里用 bit6 表示以便逐位展示。
 */

export const GEN_RATE = { 1: 2.5, 2: 5.0, 3: 8.0, 4: 16.0, 5: 32.0, 6: 64.0 };

export const RATE_BY_GEN = {
  1: '2.5 GT/s',
  2: '5.0 GT/s',
  3: '8.0 GT/s',
  4: '16.0 GT/s',
  5: '32.0 GT/s',
  6: '64.0 GT/s',
};
export const OS_ID = {
  TS1: 0x1e,
  TS2: 0x2d,
  EIOS: 0x3c,
  EIEOS: 0x66,
  SKP: 0xaa,
  SDS: 0xe1,
};

export const PAD = 0xf7;

export function encodingOf(gen) {
  if (gen <= 2) return '8b/10b';
  if (gen <= 5) return '128b/130b';
  return '1b/1b (PAM4 + FEC)';
}

/** 每 Lane 有效字节速率（GB/s）。 */
export function dataRateGBs(gen, width) {
  const rate = GEN_RATE[gen] ?? 8.0;
  let eff = rate;
  if (gen <= 2) eff *= 0.8;
  else if (gen <= 5) eff *= 128 / 130;
  return (eff * Math.max(1, width)) / 8;
}
/** 传输 n 个字节所需时间（ns）。 */
export function byteTimeNs(gen, width, nbytes) {
  const gbs = dataRateGBs(gen, width);
  if (!gbs) return 0;
  return (nbytes / 1e9 / gbs) * 1e9;
}

/** 一个 16 符号有序集在链路上的传输时间（ns）。 */
export function orderedSetTimeNs(gen, width) {
  return byteTimeNs(gen, width, 16);
}

/** 生成“支持速率”位图：2.5 GT/s 起直到 maxGen。 */
export function ratesBitmap(maxGen) {
  let v = 0;
  for (let g = 1; g <= Math.min(6, maxGen); g += 1) v |= 1 << g;
  return v;
}

export function ratesText(bitmap) {
  const names = [];
  for (let g = 1; g <= 6; g += 1) {
    if (bitmap & (1 << g)) names.push(RATE_BY_GEN[g]);
  }
  return names.length ? names.join(' / ') : '未宣告';
}

/** 紧凑写法，用于表格列：2.5/5.0/8.0 GT/s */
export function ratesCompact(bitmap) {
  const names = [];
  for (let g = 1; g <= 6; g += 1) {
    if (bitmap & (1 << g)) names.push(RATE_BY_GEN[g].replace(' GT/s', ''));
  }
  return names.length ? `${names.join('/')} GT/s` : '未宣告';
}

export function controlText(value) {
  const names = [];
  if (value & 0x1) names.push('Hot Reset');
  if (value & 0x2) names.push('Disable Link');
  if (value & 0x4) names.push('Loopback');
  if (value & 0x8) names.push('Disable Scrambling');
  return names.length ? names.join(', ') : 'None';
}

export function hex2(v) {
  return '0x' + (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * 构造有序集。
 * laneNumbers 中为 null 的 Lane 发送 PAD；linkPAD=true 时 Link Number 也发 PAD。
 */
export function buildOrderedSet(kind, opts = {}) {
  const {
    link = 0,
    linkPAD = false,
    width = 4,
    laneNumbers = null,
    nFts = 4,
    gen = 3,
    rates = null,
    speedChange = false,
    flitMode = false,
    control = 0,
  } = opts;

  const rateBits = rates ?? ratesBitmap(gen);
  const nums = laneNumbers ?? Array.from({ length: width }, (_, i) => i);
  const linkByte = linkPAD ? PAD : link & 0xff;

  const lanes = [];
  for (let i = 0; i < width; i += 1) {
    const num = nums[i];
    const isPad = num === null || num === undefined;
    const symbols = new Array(16).fill(0);
    if (kind === 'EIEOS') {
      for (let s = 0; s < 8; s += 1) symbols[s] = 0x00;
      for (let s = 8; s < 16; s += 1) symbols[s] = 0xff;
    } else {
      symbols[0] = OS_ID[kind] ?? 0x00;
      symbols[1] = linkByte;
      symbols[2] = isPad ? PAD : num & 0xff;
      symbols[3] = nFts & 0xff;
      symbols[4] = (rateBits & 0x7e) | (flitMode ? 0x01 : 0x00) | (speedChange ? 0x80 : 0);
      symbols[5] = control & 0x0f;
      if (kind === 'TS1' || kind === 'TS2') {
        const idByte = kind === 'TS1' ? 0x4a : 0x45;
        if (gen <= 2) {
          for (let s = 6; s < 16; s += 1) symbols[s] = idByte;
        } else {
          for (let s = 10; s < 16; s += 1) symbols[s] = idByte;
        }
      }
    }
    lanes.push({
      lane: i,
      number: isPad ? null : num,
      link: linkPAD ? null : link,
      symbols,
    });
  }

  const bytes = lanes[0].symbols.slice();
  const fields = osFields(kind, bytes, {
    link, linkPAD, laneNumber: lanes[0].number, nFts, rates: rateBits, speedChange, flitMode, control,
  });
  const symbolTable = buildSymbolTable(kind, gen, bytes, {
    link, linkPAD, laneNumber: lanes[0].number, nFts, rates: rateBits, speedChange, flitMode, control,
  });
  const laneText = lanes[0].number === null ? 'Lane=PAD' : `Lane=${lanes[0].number}`;
  const summary = kind === 'EIEOS'
    ? 'EIEOS：00h ×8 / FFh ×8 电气空闲退出码型'
    : `${kind}  Link=${linkPAD ? 'PAD' : link}  ${laneText}  N_FTS=${nFts}`
      + `  支持=${ratesText(rateBits)}${flitMode ? '  Flit=1' : ''}${speedChange ? '  SpeedChange=1' : ''}`;

  return {
    kind: 'OS',
    name: kind,
    summary,
    bytes,
    lanes,
    fields,
    symbolTable,
    link: linkPAD ? PAD : link,
    linkPAD,
    width,
    gen,
    nFts,
    rates: rateBits,
    speedChange,
    flitMode,
    control,
    realTimeNs: orderedSetTimeNs(gen, width),
  };
}

function osFields(kind, bytes, { link, linkPAD, laneNumber, nFts, rates, speedChange, flitMode, control }) {
  if (kind === 'EIEOS') {
    return [
      { name: 'OS 标识', value: 'Pattern', display: '00h ×8 / FFh ×8', desc: 'Electrical Idle Exit Ordered Set' },
      { name: 'Symbol 0-7', value: '0x00', display: '8 个 00h', desc: '低电平段' },
      { name: 'Symbol 8-15', value: '0xFF', display: '8 个 FFh', desc: '高电平段' },
    ];
  }
  const rateDisplay = `${ratesText(rates)}${speedChange ? ' · Speed Change=1' : ''}`;
  return [
    { name: 'OS 标识 (Symbol 0)', value: hex2(bytes[0]), display: kind === 'TS1' ? 'TS1 (1Eh)'
      : kind === 'TS2' ? 'TS2 (2Dh)' : kind === 'SKP' ? 'SKP OS (AAh)' : hex2(bytes[0]),
      desc: '接收端据此识别有序集类型' },
    { name: 'Link Number (Symbol 1)', value: linkPAD ? '0xF7' : String(link),
      display: linkPAD ? 'PAD (F7h)' : String(link),
      desc: '链路编号；Polling 阶段与未分配时必须发 PAD' },
    { name: 'Lane Number (Symbol 2)', value: laneNumber === null ? '0xF7' : String(laneNumber),
      display: laneNumber === null ? 'PAD (F7h)' : String(laneNumber),
      desc: '通道编号；Polling 与 Linkwidth.Start 阶段为 PAD' },
    { name: 'N_FTS (Symbol 3)', value: String(nFts), display: String(nFts),
      desc: '从 L0s 返回 L0 需要发送的 FTS 数量' },
    { name: 'Data Rate (Symbol 4)', value: hex2(bytes[4]),
      display: `${flitMode ? 'Flit Mode=1 · ' : ''}${rateDisplay}`,
      desc: 'bit0 = Flit Mode Supported；bit1-6 表示支持 2.5/5.0/8.0/16.0/32.0/64.0 GT/s；bit7 为 Speed Change' },
    { name: 'Training Control (Symbol 5[3:0])', value: `0b${(control & 0x0f).toString(2).padStart(4, '0')}`,
      display: controlText(control), desc: 'Hot Reset / Disable / Loopback / Disable Scrambling' },
    { name: 'Symbol 6-15', value: '标识符/均衡', display: '见符号明细',
      desc: 'Gen1/2 为 4Ah(TS1)/45h(TS2) 标识符；Gen3 下 6-9 为均衡字段、10-15 为标识符' },
  ];
}

/**
 * 生成 16 个符号的编码与含义明细（以 Lane 0 为准）。
 * 每条包含 index / value / name / desc / cat。
 */
function buildSymbolTable(kind, gen, bytes, ctx) {
  const { link, linkPAD, laneNumber, nFts, rates, speedChange, flitMode, control } = ctx;
  const idByte = kind === 'TS1' ? 0x4a : 0x45;
  const idName = kind === 'TS1' ? 'TS1 Identifier' : 'TS2 Identifier';
  const idDesc = kind === 'TS1'
    ? '4Ah（D10.2）：TS1 标识符，用于填满有序集剩余符号'
    : '45h（D5.2）：TS2 标识符，用于填满有序集剩余符号';

  return bytes.map((value, index) => {
    let name = '保留/填充';
    let desc = '训练阶段保留，置 0';
    let cat = 'reserved';

    if (kind === 'EIEOS') {
      name = index < 8 ? '低电平 Symbol' : '高电平 Symbol';
      desc = index < 8 ? 'EIEOS 前半段固定 00h' : 'EIEOS 后半段固定 FFh';
      return { index, value, name, desc, cat: 'fixed' };
    }

    if (index === 0) {
      cat = 'id';
      name = 'OS 标识';
      if (kind === 'TS1') desc = 'TS1 有序集标识：逻辑视图 1Eh；Gen1/2 实际以 COM(K28.5) + D10.2 表示';
      else if (kind === 'TS2') desc = 'TS2 有序集标识：逻辑视图 2Dh；Gen1/2 实际以 COM(K28.5) + D5.2 表示';
      else if (kind === 'SKP') desc = 'SKP 有序集标识：用于时钟补偿（AAh 为逻辑视图）';
      else desc = '有序集起始标识';
      return { index, value, name, desc, cat };
    }

    if (kind === 'SKP') {
      name = index <= 2 ? '保留' : 'SKP 填充符号';
      desc = index <= 2 ? '保留字段，置 0' : 'SKP 有序集的填充符号（逻辑视图）';
      return { index, value, name, desc, cat: 'reserved' };
    }

    if (index === 1) {
      name = 'Link Number';
      if (linkPAD) {
        cat = 'pad';
        desc = 'PAD（F7h）：链路编号尚未分配（Polling 与 Linkwidth.Start 初期）';
      } else {
        cat = 'field';
        desc = `Link = ${link}：本链路的链路编号`;
      }
      return { index, value, name, desc, cat };
    }

    if (index === 2) {
      name = 'Lane Number';
      if (laneNumber === null) {
        cat = 'pad';
        desc = 'PAD（F7h）：通道编号尚未分配（Polling / Linkwidth.Start）';
      } else {
        cat = 'field';
        desc = `Lane = ${laneNumber}：该符号所在通道的编号`;
      }
      return { index, value, name, desc, cat };
    }

    if (index === 3) {
      name = 'N_FTS';
      desc = `N_FTS = ${nFts}：从 L0s 返回 L0 需要连续发送的 FTS 有序集数量`;
      return { index, value, name, desc, cat: 'field' };
    }

    if (index === 4) {
      name = 'Data Rate Identifier';
      desc = `bit0 Flit Mode Supported=${flitMode ? 1 : 0}；`
        + `bit1-6 为支持速率位图（当前：${ratesText(rates)}）；`
        + `bit7 Speed Change=${speedChange ? 1 : 0}${speedChange ? '（请求切换速率）' : ''}`;
      return { index, value, name, desc, cat: 'field' };
    }

    if (index === 5) {
      name = 'Training Control';
      desc = `bit0 Hot Reset / bit1 Disable / bit2 Loopback / bit3 Disable Scrambling；`
        + `当前：${controlText(control)}`;
      return { index, value, name, desc, cat: 'field' };
    }

    if (gen <= 2) {
      name = idName;
      desc = `${idDesc}（8b/10b 下重复出现，提供足够跳变）`;
      return { index, value, name, desc, cat: 'id' };
    }

    if (index === 6) {
      name = 'EC / Tx Preset / Use Preset';
      desc = '均衡控制（bit1:0）、发送预设（bit6:3）与 Use Preset（bit7）；仅 Recovery.Equalization 使用，其他状态为 00h';
      return { index, value, name, desc, cat: 'eq' };
    }
    if (index === 7) {
      name = 'FS / Pre-cursor';
      desc = 'EC=01b 时为 Full Swing（FS）；否则为 Pre-cursor 系数（bit5:0）';
      return { index, value, name, desc, cat: 'eq' };
    }
    if (index === 8) {
      name = 'LF / Cursor';
      desc = 'EC=01b 时为 Low Frequency（LF）；否则为 Cursor 系数（bit5:0）';
      return { index, value, name, desc, cat: 'eq' };
    }
    if (index === 9) {
      name = 'Post-cursor / Reject / Parity';
      desc = 'Post-cursor 系数（bit5:0）、Reject Coefficient Values（bit6）、偶校验（bit7）';
      return { index, value, name, desc, cat: 'eq' };
    }
    if (index >= 10 && index <= 13) {
      name = idName;
      desc = `${idDesc}（Gen3 下位于 Symbol 10-13）`;
      return { index, value, name, desc, cat: 'id' };
    }
    name = 'Identifier / DC-Balance';
    desc = `${idByte === 0x4a ? '4Ah' : '45h'} 标识符，或用于直流平衡的替换符号`;
    return { index, value, name, desc, cat: 'id' };
  });
}

export function decodeOrderedSet(bytes) {
  const ident = bytes[0];
  const kind = Object.keys(OS_ID).find((k) => OS_ID[k] === ident) ?? 'UNKNOWN';
  if (kind === 'EIEOS') return { kind, fields: osFields(kind, bytes, {}) };
  const rates = bytes[4] & 0x7e;
  const speedChange = (bytes[4] & 0x80) !== 0;
  const flitMode = (bytes[4] & 0x01) !== 0;
  const control = bytes[5] & 0x0f;
  const laneNumber = bytes[2] === PAD ? null : bytes[2];
  const linkPAD = bytes[1] === PAD;
  return {
    kind,
    link: bytes[1],
    linkPAD,
    laneNumber,
    nFts: bytes[3],
    rates,
    speedChange,
    flitMode,
    control,
    fields: osFields(kind, bytes, {
      link: bytes[1], linkPAD, laneNumber, nFts: bytes[3], rates, speedChange, flitMode, control,
    }),
  };
}
