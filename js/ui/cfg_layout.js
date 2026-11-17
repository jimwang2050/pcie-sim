/**
 * 配置空间 Header Layout：Type 0（端点）与 Type 1（PCI-to-PCI Bridge / Root Port）。
 *
 * 每行一个 32-bit DWORD（word），字段宽度按位宽比例排布；
 * 点击字段在下方弹出位域定义（Bits / 访问属性 / 复位值 / 当前值 / 说明）。
 * 字段命名、位偏移与复位值参考 DWC PCIe DBI 寄存器报告：
 *   - USP：PF0_TYPE0_HDR（DEVICE_ID_VENDOR_ID_REG …）
 *   - DSP：PF0_TYPE1_HDR（TYPE1_STATUS_COMMAND_REG …）
 */

const STATUS0_BITS = [
  { bit: 0, name: 'Immediate Readiness', dwc: 'IMM_READINESS', desc: '1 表示 D0uninitialized 后无需等待即可访问' },
  { bit: 3, name: 'Interrupt Status', dwc: 'INT_STATUS', desc: 'INTx 中断挂起' },
  { bit: 4, name: 'Capabilities List', dwc: 'CAP_LIST', desc: '存在 Capability 链表（0x34 的指针有效）' },
  { bit: 5, name: '66 MHz Capable', dwc: 'FAST_66MHZ_CAP', desc: '支持 66 MHz（PCI 兼容位）' },
  { bit: 7, name: 'Fast Back-to-Back Capable', dwc: 'FAST_B2B_CAP', desc: '支持快速背靠背事务' },
  { bit: 8, name: 'Master Data Parity Error', dwc: 'MASTER_DPE', desc: '主设备数据奇偶错误' },
  { bit: 11, name: 'Signaled Target Abort', dwc: 'SIGNALED_TARGET_ABORT', desc: '作为目标发出 Target Abort' },
  { bit: 12, name: 'Received Target Abort', dwc: 'RCVD_TARGET_ABORT', desc: '收到 Target Abort' },
  { bit: 13, name: 'Received Master Abort', dwc: 'RCVD_MASTER_ABORT', desc: '收到 Master Abort' },
  { bit: 14, name: 'Signaled System Error', dwc: 'SIGNALED_SYS_ERROR', desc: '发出 SERR' },
  { bit: 15, name: 'Detected Parity Error', dwc: 'DETECTED_PARITY_ERROR', desc: '检出奇偶错误' },
];

const COMMAND0_BITS = [
  { bit: 0, name: 'I/O Space', dwc: 'IO_EN', desc: '使能 I/O 空间解码' },
  { bit: 1, name: 'Memory Space', dwc: 'MSE', desc: '使能 Memory 空间解码' },
  { bit: 2, name: 'Bus Master', dwc: 'BME', desc: '使能作为总线主设备发起 DMA' },
  { bit: 3, name: 'Special Cycles', dwc: 'SCO', desc: '使能特殊周期' },
  { bit: 4, name: 'Memory Write & Invalidate', dwc: 'MWI_EN', desc: '内存写并无效化' },
  { bit: 5, name: 'VGA Palette Snoop', dwc: 'VGAPS', desc: 'VGA 调色板监听' },
  { bit: 6, name: 'Parity Error Response', dwc: 'PERREN', desc: '奇偶校验错误响应' },
  { bit: 7, name: 'IDSEL Stepping', dwc: 'IDSEL', desc: 'IDSEL 步进等待周期' },
  { bit: 8, name: 'SERR Enable', dwc: 'SERREN', desc: '系统错误使能' },
  { bit: 9, name: 'Fast Back-to-Back Enable', dwc: 'RSVDP_9', desc: '快速背靠背事务使能（Type 0）' },
  { bit: 10, name: 'Interrupt Disable', dwc: 'INT_EN', desc: '禁止 INTx 中断' },
];

const STATUS1_BITS = STATUS0_BITS;

const COMMAND1_BITS = COMMAND0_BITS.map((b) => (b.bit === 9
  ? { ...b, name: 'Reserved', desc: 'Type 1 中该位保留（无 Fast Back-to-Back Enable）' }
  : b));

const SEC_STATUS_BITS = [
  { bit: 8, name: 'Master Data Parity Error', dwc: 'SEC_STAT_MDPE', desc: '下游侧主设备数据奇偶错误' },
  { bit: 11, name: 'Signaled Target Abort', dwc: 'SEC_STAT_SIG_TRGT_ABRT', desc: '下游侧发出 Target Abort' },
  { bit: 12, name: 'Received Target Abort', dwc: 'SEC_STAT_RCVD_TRGT_ABRT', desc: '下游侧收到 Target Abort' },
  { bit: 13, name: 'Received Master Abort', dwc: 'SEC_STAT_RCVD_MSTR_ABRT', desc: '下游侧收到 Master Abort' },
  { bit: 14, name: 'Received System Error', dwc: 'SEC_STAT_RCVD_SYS_ERR', desc: '下游侧收到 SERR' },
  { bit: 15, name: 'Detected Parity Error', dwc: 'SEC_STAT_DPE', desc: '下游侧检出奇偶错误' },
];

const BRIDGE_CTRL_BITS = [
  { bit: 0, name: 'Parity Error Response Enable', dwc: 'PERE', desc: '下游侧奇偶错误响应使能' },
  { bit: 1, name: 'SERR Enable', dwc: 'SERR_EN', desc: '下游侧 SERR 上报使能' },
  { bit: 2, name: 'ISA Enable', dwc: 'ISA_EN', desc: '只转发 ISA 兼容的 I/O 地址' },
  { bit: 3, name: 'VGA Enable', dwc: 'VGA_EN', desc: '转发 VGA 地址与 VGA 兼容 I/O' },
  { bit: 4, name: 'VGA 16-bit Decode', dwc: 'VGA_16B_DEC', desc: 'VGA 地址使用 16-bit 解码' },
  { bit: 5, name: 'Master Abort Mode', dwc: 'MSTR_ABORT_MODE', desc: '主设备中止时返回 0xFFFFFFFF 而非 UR' },
  { bit: 6, name: 'Secondary Bus Reset', dwc: 'SBR', desc: '置 1 通过 TS1 Hot Reset 复位下游总线' },
];

/* ---------- Type 0：端点（16 个 DWORD） ---------- */

const TYPE0_ROWS = [
  {
    offset: 0x00,
    reg: 'DEVICE_ID_VENDOR_ID_REG',
    fields: [
      { name: 'Device ID', hi: 31, lo: 16, access: 'RO', dwc: 'PCI_TYPE0_DEVICE_ID', desc: '设备 ID，由厂商分配，用于驱动匹配。' },
      { name: 'Vendor ID', hi: 15, lo: 0, access: 'RO', dwc: 'PCI_TYPE0_VENDOR_ID', desc: '厂商 ID，由 PCI-SIG 分配；0xFFFF 表示设备不存在。' },
    ],
  },
  {
    offset: 0x04,
    reg: 'PCI_TYPE0_STATUS_COMMAND_REG',
    fields: [
      { name: 'Status', hi: 31, lo: 16, access: 'RO / RW1C', desc: '状态寄存器：错误、能力与中断状态（上半字）；多数状态位为 RW1C，写 1 清除。', bits: STATUS0_BITS },
      { name: 'Command', hi: 15, lo: 0, access: 'RW', desc: '命令寄存器：控制 I/O、Memory、Bus Master 与中断。', bits: COMMAND0_BITS },
    ],
  },
  {
    offset: 0x08,
    reg: 'CLASS_CODE_REVISION_ID',
    fields: [
      { name: 'Class Code', hi: 31, lo: 8, access: 'RO', desc: '类代码：Base / Sub-Class / Programming Interface。', kind: 'class' },
      { name: 'Revision ID', hi: 7, lo: 0, access: 'RO', desc: '设备修订版本。' },
    ],
  },
  {
    offset: 0x0c,
    reg: 'BIST_HEADER_TYPE_LATENCY_CACHE_LINE_SIZE_REG',
    fields: [
      { name: 'BIST', hi: 31, lo: 24, access: 'RW', desc: 'Built-In Self Test 控制/状态。' },
      { name: 'Header Type', hi: 23, lo: 16, access: 'RO', desc: 'Header 布局；bit7=1 表示多功能设备，[6:0]=0 为 Type 0。', kind: 'header' },
      { name: 'Latency Timer', hi: 15, lo: 8, access: 'RW', desc: '主设备延迟计时器（PCI 兼容）。' },
      { name: 'Cache Line Size', hi: 7, lo: 0, access: 'RW', desc: 'Cache Line 大小，以 DWORD 为单位。' },
    ],
  },
  {
    offset: 0x10,
    reg: 'BAR0_REG',
    fields: [{ name: 'BAR0', hi: 31, lo: 0, access: 'RW', desc: '基址寄存器 0（本设备为 64-bit Memory BAR 的低 32 位）。', kind: 'bar' }],
  },
  {
    offset: 0x14,
    reg: 'BAR1_REG',
    fields: [{ name: 'BAR1', hi: 31, lo: 0, access: 'RW', desc: 'BAR0 的高 32 位（64-bit BAR）。', kind: 'bar' }],
  },
  {
    offset: 0x18,
    reg: 'BAR2_REG',
    fields: [{ name: 'BAR2', hi: 31, lo: 0, access: 'RW', desc: '基址寄存器 2（32-bit Memory BAR）。', kind: 'bar' }],
  },
  {
    offset: 0x1c,
    reg: 'BAR3_REG',
    fields: [{ name: 'BAR3', hi: 31, lo: 0, access: 'RW', desc: '基址寄存器 3（32-bit Memory BAR）。', kind: 'bar' }],
  },
  {
    offset: 0x20,
    reg: 'BAR4_REG',
    fields: [{ name: 'BAR4', hi: 31, lo: 0, access: 'RW', desc: '基址寄存器 4（本模型未实现）。', kind: 'bar' }],
  },
  {
    offset: 0x24,
    reg: 'BAR5_REG',
    fields: [{ name: 'BAR5', hi: 31, lo: 0, access: 'RW', desc: '基址寄存器 5（本模型未实现）。', kind: 'bar' }],
  },
  {
    offset: 0x28,
    reg: 'CARDBUS_CIS_PTR_REG',
    fields: [{ name: 'CardBus CIS Pointer', hi: 31, lo: 0, access: 'RO', desc: 'CardBus CIS 指针（PCIe 端点通常为 0）。' }],
  },
  {
    offset: 0x2c,
    reg: 'SUBSYSTEM_ID_SUBSYSTEM_VENDOR_ID_REG',
    fields: [
      { name: 'Subsystem ID', hi: 31, lo: 16, access: 'RO', dwc: 'SUBSYS_DEV_ID', desc: '子系统 ID，由厂商分配。' },
      { name: 'Subsystem Vendor ID', hi: 15, lo: 0, access: 'RO', dwc: 'SUBSYS_VENDOR_ID', desc: '子系统厂商 ID。' },
    ],
  },
  {
    offset: 0x30,
    reg: 'EXP_ROM_BASE_ADDR_REG',
    fields: [{ name: 'Expansion ROM BAR', hi: 31, lo: 0, access: 'RW', desc: 'Expansion ROM 基址：bit0=1 使能，地址按 2 KB 对齐；大小经 shadow mask 寄存器写全 1 后回读探测。', kind: 'exprom' }],
  },
  {
    offset: 0x34,
    reg: 'PCI_CAP_PTR_REG',
    fields: [
      { name: 'Reserved', hi: 31, lo: 8, access: 'RO', desc: '保留。' },
      { name: 'Capability Pointer', hi: 7, lo: 0, access: 'RO', dwc: 'CAP_POINTER', desc: '第一个 Capability 的偏移（DWC 默认 0x40；本模型为 0，未实现链表）。' },
    ],
  },
  {
    offset: 0x38,
    reg: '—',
    fields: [{ name: 'Reserved', hi: 31, lo: 0, access: 'RO', desc: '保留。' }],
  },
  {
    offset: 0x3c,
    reg: 'MAX_LATENCY_MIN_GRANT_INTERRUPT_PIN_INTERRUPT_LINE_REG',
    fields: [
      { name: 'Max_Lat', hi: 31, lo: 24, access: 'RO', desc: '最大延迟（PCI 兼容，单位 1/4 µs）。' },
      { name: 'Min_Gnt', hi: 23, lo: 16, access: 'RO', desc: '最小授予时间（PCI 兼容，单位 1/4 µs）。' },
      { name: 'Interrupt Pin', hi: 15, lo: 8, access: 'RO', dwc: 'INT_PIN', desc: 'INTx 引脚：0=不使用，1=INTA … 4=INTD。', kind: 'intpin' },
      { name: 'Interrupt Line', hi: 7, lo: 0, access: 'RW', dwc: 'INT_LINE', desc: '系统中断线分配（由软件写入）。' },
    ],
  },
];

/* ---------- Type 1：PCI-to-PCI Bridge / Root Port（16 个 DWORD，参考值） ---------- */

const TYPE1_ROWS = [
  {
    offset: 0x00,
    reg: 'TYPE1_DEV_ID_VEND_ID_REG',
    value: 0xabcd16c3,
    fields: [
      { name: 'Device ID', hi: 31, lo: 16, access: 'RO', reset: '0xABCD', dwc: 'DEVICE_ID', desc: '桥 / 端口的设备 ID（DWC 默认 0xABCD）。' },
      { name: 'Vendor ID', hi: 15, lo: 0, access: 'RO', reset: '0x16C3', dwc: 'VENDOR_ID', desc: '厂商 ID（DWC 默认 0x16C3）。' },
    ],
  },
  {
    offset: 0x04,
    reg: 'TYPE1_STATUS_COMMAND_REG',
    value: 0x00110000,
    fields: [
      { name: 'Status', hi: 31, lo: 16, access: 'RO / RW1C', desc: '状态寄存器：错误、能力与中断状态（上半字）；多数状态位为 RW1C，写 1 清除。', bits: STATUS1_BITS },
      { name: 'Command', hi: 15, lo: 0, access: 'RW', desc: '命令寄存器：控制 I/O、Memory、Bus Master、SERR 与 INTx。', bits: COMMAND1_BITS },
    ],
  },
  {
    offset: 0x08,
    reg: 'TYPE1_CLASS_CODE_REV_ID_REG',
    value: 0x06040001,
    fields: [
      { name: 'Class Code', hi: 31, lo: 8, access: 'RO', desc: '类代码；桥为 0x060400（Base 0x06 = Bridge，Sub 0x04 = PCI-to-PCI）。', kind: 'class' },
      { name: 'Revision ID', hi: 7, lo: 0, access: 'RO', reset: '0x01', dwc: 'REVISION_ID', desc: '修订版本。' },
    ],
  },
  {
    offset: 0x0c,
    reg: 'TYPE1_BIST_HDR_TYPE_LAT_CACHE_LINE_SIZE_REG',
    value: 0x00010000,
    fields: [
      { name: 'BIST', hi: 31, lo: 24, access: 'RO', dwc: 'BIST', desc: 'Built-In Self Test（桥通常不实现）。' },
      { name: 'Header Type', hi: 23, lo: 16, access: 'RO', reset: '0x01', dwc: 'HEADER_TYPE', desc: 'Header 布局；bit7=1 表示多功能，[6:0]=1 为 Type 1。', kind: 'header' },
      { name: 'Primary Latency Timer', hi: 15, lo: 8, access: 'RO', dwc: 'LATENCY_MASTER_TIMER', desc: '上游侧延迟计时器（PCI 兼容）。' },
      { name: 'Cache Line Size', hi: 7, lo: 0, access: 'RW', dwc: 'CACHE_LINE_SIZE', desc: 'Cache Line 大小，以 DWORD 为单位。' },
    ],
  },
  {
    offset: 0x10,
    reg: 'BAR0_REG',
    value: 0x00000004,
    fields: [{ name: 'BAR0', hi: 31, lo: 0, access: 'RW', desc: '基址寄存器 0；示例为 64-bit Memory BAR（bit0=0，bits2:1=10）。', kind: 'bar-ref' }],
  },
  {
    offset: 0x14,
    reg: 'BAR1_REG',
    value: 0x00000000,
    fields: [{ name: 'BAR1 / BAR0 高半', hi: 31, lo: 0, access: 'RW', desc: 'BAR0 为 64-bit 时的上半部分。', kind: 'bar-ref' }],
  },
  {
    offset: 0x18,
    reg: 'SEC_LAT_TIMER_SUB_BUS_SEC_BUS_PRI_BUS_REG',
    value: 0x00020100,
    fields: [
      { name: 'Secondary Latency Timer', hi: 31, lo: 24, access: 'RO', dwc: 'SEC_LAT_TIMER', desc: '下游侧延迟计时器（PCI 兼容）。' },
      { name: 'Subordinate Bus Number', hi: 23, lo: 16, access: 'RW', dwc: 'SUB_BUS', reset: '0x02', desc: '下游总线号范围的上界（Subordinate）。' },
      { name: 'Secondary Bus Number', hi: 15, lo: 8, access: 'RW', dwc: 'SEC_BUS', reset: '0x01', desc: '桥下游总线号（Secondary）。' },
      { name: 'Primary Bus Number', hi: 7, lo: 0, access: 'RW', dwc: 'PRIM_BUS', reset: '0x00', desc: '桥上游总线号（Primary）。' },
    ],
  },
  {
    offset: 0x1c,
    reg: 'SEC_STAT_IO_LIMIT_IO_BASE_REG',
    value: 0x10100000,
    fields: [
      { name: 'I/O Limit', hi: 31, lo: 24, access: 'RW', desc: 'I/O 上限：bits31:28 = limit[15:12]；bit24=1 表示 32-bit I/O 解码。' },
      { name: 'I/O Base', hi: 23, lo: 16, access: 'RW', desc: 'I/O 基址：bits23:20 = base[15:12]；bit16=1 表示 32-bit I/O 解码。' },
      { name: 'Secondary Status', hi: 15, lo: 0, access: 'RO / RW1C', desc: '下游侧状态：错误与中止记录。', bits: SEC_STATUS_BITS },
    ],
  },
  {
    offset: 0x20,
    reg: 'MEM_LIMIT_MEM_BASE_REG',
    value: 0xc000c000,
    fields: [
      { name: 'Memory Limit', hi: 31, lo: 16, access: 'RW', desc: 'Memory 上限：limit[31:20] 位于 bits31:20。' },
      { name: 'Memory Base', hi: 15, lo: 0, access: 'RW', desc: 'Memory 基址：base[31:20] 位于 bits15:4。' },
    ],
  },
  {
    offset: 0x24,
    reg: 'PREF_MEM_LIMIT_PREF_MEM_BASE_REG',
    value: 0xd001d001,
    fields: [
      { name: 'Prefetchable Memory Limit', hi: 31, lo: 16, access: 'RW', desc: '可预取 Memory 上限；bits19:16=0x1 表示支持 64-bit。' },
      { name: 'Prefetchable Memory Base', hi: 15, lo: 0, access: 'RW', desc: '可预取 Memory 基址；bits3:0=0x1 表示支持 64-bit。' },
    ],
  },
  {
    offset: 0x28,
    reg: 'PREF_BASE_UPPER_REG',
    value: 0x00000000,
    fields: [{ name: 'Prefetchable Base Upper 32', hi: 31, lo: 0, access: 'RW', dwc: 'PREF_MEM_BASE_UPPER', desc: '可预取 Memory 基址的高 32 位。' }],
  },
  {
    offset: 0x2c,
    reg: 'PREF_LIMIT_UPPER_REG',
    value: 0x00000000,
    fields: [{ name: 'Prefetchable Limit Upper 32', hi: 31, lo: 0, access: 'RW', dwc: 'PREF_MEM_LIMIT_UPPER', desc: '可预取 Memory 上限的高 32 位。' }],
  },
  {
    offset: 0x30,
    reg: 'IO_LIMIT_UPPER_IO_BASE_UPPER_REG',
    value: 0x00000000,
    fields: [
      { name: 'I/O Limit Upper 16', hi: 31, lo: 16, access: 'RO', dwc: 'IO_LIMIT_UPPER', desc: 'I/O 上限高 16 位（32-bit I/O 解码时使用）。' },
      { name: 'I/O Base Upper 16', hi: 15, lo: 0, access: 'RO', dwc: 'IO_BASE_UPPER', desc: 'I/O 基址高 16 位（32-bit I/O 解码时使用）。' },
    ],
  },
  {
    offset: 0x34,
    reg: 'TYPE1_CAP_PTR_REG',
    value: 0x00000040,
    fields: [
      { name: 'Reserved', hi: 31, lo: 8, access: 'RO', desc: '保留。' },
      { name: 'Capability Pointer', hi: 7, lo: 0, access: 'RO', reset: '0x40', dwc: 'CAP_POINTER', desc: '第一个 Capability 的偏移（DWC 默认 0x40）。' },
    ],
  },
  {
    offset: 0x38,
    reg: 'TYPE1_EXP_ROM_BASE_REG',
    value: 0x00000000,
    fields: [{ name: 'Expansion ROM BAR', hi: 31, lo: 0, access: 'RW', desc: 'Expansion ROM 基址：bit0=1 使能，地址按 2 KB 对齐；大小经 shadow mask 寄存器写全 1 后回读探测。复位值 0。', kind: 'exprom' }],
  },
  {
    offset: 0x3c,
    reg: 'BRIDGE_CTRL_INT_PIN_INT_LINE_REG',
    value: 0x000001ff,
    fields: [
      { name: 'Bridge Control', hi: 31, lo: 16, access: 'RW', desc: '下游接口控制：VGA / ISA / SERR / 次级总线复位等。', bits: BRIDGE_CTRL_BITS },
      { name: 'Interrupt Pin', hi: 15, lo: 8, access: 'RO', reset: '0x01', dwc: 'INT_PIN', desc: 'INTx 引脚：0=不使用，1=INTA … 4=INTD。', kind: 'intpin' },
      { name: 'Interrupt Line', hi: 7, lo: 0, access: 'RW', reset: '0xFF', dwc: 'INT_LINE', desc: '系统中断线分配（由软件写入）。' },
    ],
  },
];

export const CFG_LAYOUTS = { type0: TYPE0_ROWS, type1: TYPE1_ROWS };

const ACCESS_CLASS = {
  RO: 'ro',
  RW: 'rw',
  'RW1C': 'rw1c',
  'RO / RW1C': 'rw1c',
};

function hex(v, width = 8) {
  return `0x${(v >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function fieldValue(dw, lo, hi) {
  const width = hi - lo + 1;
  if (width >= 32) return dw >>> 0;
  return (dw >>> lo) & ((1 << width) - 1);
}

function sizeText(size) {
  if (size >= 1024 * 1024) return `${size / (1024 * 1024)} MB`;
  return `${Math.round(size / 1024)} KB`;
}

function rowsOf(type) {
  return CFG_LAYOUTS[type] || CFG_LAYOUTS.type0;
}

function rowValue(row, config, type) {
  return type === 'type1' ? (row.value >>> 0) : config.read(row.offset);
}

function bitsHtml(value, bits) {
  return `<table class="cfg-bits">
    <thead><tr><th>Bit</th><th>字段</th><th>DWC 名称</th><th>当前</th><th>说明</th></tr></thead>
    <tbody>${bits.map((b) => {
    const on = ((value >>> b.bit) & 1) === 1;
    return `<tr class="${on ? 'on' : ''}"><td>${b.bit}</td><td>${b.name}</td>
      <td class="cfg-dwc">${b.dwc || '—'}</td><td>${on ? '1' : '0'}</td><td>${b.desc}</td></tr>`;
  }).join('')}</tbody>
  </table>`;
}

/** DWC BAR 位域：BARn_MEM_IO / BARn_TYPE / BARn_PREFETCH / BARn_START。 */
function barBitsHtml(dw, offset, upper) {
  const idx = Math.max(0, Math.round((offset - 0x10) / 4));
  const n = `BAR${idx}`;
  const memio = dw & 1;
  const type = (dw >>> 1) & 0x3;
  const pref = (dw >>> 3) & 1;
  const base = dw & 0xfffffff0;
  const typeText = type === 0 ? '32-bit Memory' : type === 2 ? '64-bit Memory'
    : type === 1 ? 'I/O（1 MB 以下）' : '保留';
  const rows = [
    [0, 'Memory / I/O 指示', `${n}_MEM_IO`, 'RO',
      memio ? '1（I/O BAR）' : '0（Memory BAR）', '0 = Memory，1 = I/O'],
    ['2:1', 'BAR 类型', `${n}_TYPE`, 'RO',
      `0b${type.toString(2).padStart(2, '0')}（${typeText}）`,
      '00 = 32-bit，10 = 64-bit；64-bit 时下一个 BAR 存放高 32 位'],
    [3, 'Prefetchable', `${n}_PREFETCH`, 'RO',
      pref ? '1（可预取）' : '0（不可预取）', '可预取 Memory 允许 RC 提前取数 / 合并写'],
    ['31:4', '基址 [31:4]', `${n}_START`, 'RW', hex(base),
      '写全 1 后回读掩码可探测 BAR 大小；对齐边界由掩码决定'],
  ];
  return `<p><b>DWC 位域（${n}_REG${upper ? ' · 64-bit 高半' : ''}）</b></p>
    <table class="cfg-bits">
      <thead><tr><th>Bit</th><th>字段</th><th>DWC 名称</th><th>属性</th><th>当前</th><th>说明</th></tr></thead>
      <tbody>${rows.map(([bit, name, dwc, acc, cur, desc]) => `<tr>
        <td>${bit}</td><td>${name}</td><td class="cfg-dwc">${dwc}</td>
        <td>${acc}</td><td>${cur}</td><td>${desc}</td></tr>`).join('')}</tbody>
    </table>`;
}

/** DWC Expansion ROM 位域：EXP_ROM_BASE_ADDR_REG（大小由 shadow mask 寄存器探测）。 */
function expromBitsHtml(dw) {
  const en = dw & 1;
  const status = (dw >>> 1) & 0x7;
  const detail = (dw >>> 4) & 0xf;
  const base = dw & 0xfffff800;
  const rows = [
    [0, 'ROM BAR Enable', 'ROM_BAR_ENABLE', 'RW',
      en ? '1（已使能）' : '0（未使能）', '1 = 使能 Expansion ROM 地址解码'],
    ['3:1', '校验状态', 'ROM_BAR_VALIDATION_STATUS', 'RW',
      `0b${status.toString(2).padStart(3, '0')}`, 'ROM 校验状态（DWC 私有语义）'],
    ['7:4', '校验详情', 'ROM_BAR_VALIDATION_DETAILS', 'RW',
      `0x${detail.toString(16).toUpperCase()}`, 'ROM 校验细节（DWC 私有语义）'],
    ['10:8', 'Reserved', 'RSVDP_8', 'RO', '0', '保留'],
    ['31:11', 'ROM 基址 [31:11]', 'EXP_ROM_BASE_ADDRESS', 'RW', hex(base),
      '地址按 2 KB 对齐；ROM 大小由 shadow 寄存器决定'],
  ];
  return `<p><b>DWC 位域（EXP_ROM_BASE_ADDR_REG）</b></p>
    <table class="cfg-bits">
      <thead><tr><th>Bit</th><th>字段</th><th>DWC 名称</th><th>属性</th><th>当前</th><th>说明</th></tr></thead>
      <tbody>${rows.map(([bit, name, dwc, acc, cur, desc]) => `<tr>
        <td>${bit}</td><td>${name}</td><td class="cfg-dwc">${dwc}</td>
        <td>${acc}</td><td>${cur}</td><td>${desc}</td></tr>`).join('')}</tbody>
    </table>`;
}

/** 渲染整张 Layout：type = 'type0' | 'type1'。 */
export function renderCfgLayout(el, config, type = 'type0') {
  const rows = rowsOf(type);
  const body = rows.map((row) => {
    const dw = rowValue(row, config, type);
    const fields = row.fields.map((f) => {
      const width = f.hi - f.lo + 1;
      const value = fieldValue(dw, f.lo, f.hi);
      const cls = ACCESS_CLASS[f.access] || 'ro';
      return `<button class="cfg-field ${cls}" style="flex:${width} 1 0"
        data-off="${row.offset}" data-lo="${f.lo}" data-hi="${f.hi}"
        title="${f.name} [${f.hi}:${f.lo}] = ${hex(value, Math.ceil(width / 4))}（${f.access}）">
        <span class="cfg-fname">${f.name}</span>
        <span class="cfg-fbits">[${f.hi}:${f.lo}]</span>
      </button>`;
    }).join('');
    return `<div class="cfg-row" title="${row.reg}">
      <div class="cfg-off">${hex(row.offset, 3)}</div>
      <div class="cfg-dw">${hex(dw)}</div>
      <div class="cfg-fields">${fields}</div>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="cfg-layout">
    <div class="cfg-row cfg-ruler">
      <div class="cfg-off">Offset</div>
      <div class="cfg-dw">DWORD</div>
      <div class="cfg-fields"><span>31</span><span>24</span><span>16</span><span>8</span><span>0</span></div>
    </div>
    ${body}
  </div>`;
}

/** 渲染字段详情：type 决定使用 Type 0 / Type 1 的字段定义与取值方式。 */
export function renderCfgFieldDetail(el, config, offset, lo, hi, type = 'type0') {
  const row = rowsOf(type).find((r) => r.offset === offset);
  const field = row ? row.fields.find((f) => f.lo === lo && f.hi === hi) : null;
  const dw = row ? rowValue(row, config, type) : 0;
  if (!field || !row) {
    el.innerHTML = '<p class="empty">未找到字段定义。</p>';
    return;
  }
  const width = hi - lo + 1;
  const value = fieldValue(dw, lo, hi);
  const meta = [
    `Offset ${hex(offset, 3)}`,
    `寄存器 ${row.reg}`,
    ...(field.dwc && !field.bits ? [`DWC ${field.dwc}`] : []),
    `Bits [${hi}:${lo}]`,
    `宽度 ${width} bit`,
    `访问 ${field.access}`,
    ...(field.reset ? [`复位 ${field.reset}`] : []),
    `当前 ${hex(value, Math.ceil(width / 4))}`,
  ];

  let extra = '';
  if (field.bits) {
    extra = bitsHtml(value, field.bits);
  } else if (field.kind === 'bar' || field.kind === 'bar-ref') {
    const isUpper = ((offset - 0x10) % 8) === 4;
    const table = barBitsHtml(dw, offset, isUpper);
    const lines = [];
    if (field.kind === 'bar') {
      const b = config.barAt(offset);
      if (b) {
        lines.push(`类型：${b.bar.is64 ? 'Memory 64-bit' : 'Memory 32-bit'}`);
        lines.push(`大小：${sizeText(b.bar.size)}`);
        lines.push(`当前基址：${config.baseHex(b.bar)}`);
        lines.push(`写全 1 探测掩码：${hex(config.barMask(b.bar, b.half))}`);
        lines.push(b.bar.sizing ? '状态：正在探测大小（写全 1 后回读掩码）' : '状态：正常分配');
      } else {
        lines.push('本模型未实现该 BAR。');
      }
    } else {
      lines.push(`参考值 ${hex(row.value)}：64-bit Memory BAR 示例（bit0=0，bits2:1=10，bit3=0）`);
      lines.push('Type 1 布局中的 BAR0/BAR1 是 Root Port 的 64-bit Memory BAR');
    }
    if (isUpper) lines.push('本 DWORD 是上一个 64-bit BAR 的高 32 位，仅地址高位有效');
    extra = table + `<ul class="cfg-extra">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;
  } else if (field.kind === 'class') {
    const base = (dw >>> 24) & 0xff;
    const sub = (dw >>> 16) & 0xff;
    const pi = (dw >>> 8) & 0xff;
    extra = `<ul class="cfg-extra">
      <li>Base Class：0x${base.toString(16).toUpperCase().padStart(2, '0')}</li>
      <li>Sub-Class：0x${sub.toString(16).toUpperCase().padStart(2, '0')}</li>
      <li>Programming Interface：0x${pi.toString(16).toUpperCase().padStart(2, '0')}</li>
      ${type === 'type0' ? `<li>解码名称：${config.classCodeText}</li>` : '<li>解码名称：PCI-to-PCI Bridge</li>'}
    </ul>`;
  } else if (field.kind === 'header') {
    const hdr = value & 0x7f;
    extra = `<ul class="cfg-extra">
      <li>Header Layout：Type ${hdr}（${hdr === 0 ? '端点，16 个 DWORD' : 'PCI-to-PCI Bridge，16 个 DWORD'}）</li>
      <li>Multi-Function：${(value & 0x80) ? '是' : '否'}</li>
    </ul>`;
  } else if (field.kind === 'intpin') {
    const names = ['不使用 INTx', 'INTA#', 'INTB#', 'INTC#', 'INTD#'];
    extra = `<ul class="cfg-extra"><li>当前：${names[value] || '保留'}</li></ul>`;
  } else if (field.kind === 'exprom') {
    extra = expromBitsHtml(dw) + `<ul class="cfg-extra">
      <li>大小探测：写 shadow 寄存器 EXP_ROM_BAR_MASK_REG（ROM_BAR_ENABLED + ROM_MASK[31:1]）后回读</li>
      <li>参考值 ${hex(row.value ?? dw)}：DWC 复位为 0（未使能、无 ROM）</li>
      <li>使能后 ROM 内容映射到该基址，供固件在枚举阶段读取</li>
    </ul>`;
  }

  el.innerHTML = `<h3>${field.name} <span>[${hi}:${lo}]</span></h3>
    <div class="cfg-meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
    <p>${field.desc}</p>
    ${extra}
    <p class="hint">字段命名、位偏移与复位值参考 DWC PCIe DBI 寄存器报告（PF0_${type === 'type1' ? 'TYPE1' : 'TYPE0'}_HDR）。</p>`;
}
