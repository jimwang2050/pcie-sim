/**
 * Hot-Plug 模型：槽位的在位检测、上电、复位、指示灯与热插拔中断。
 *
 * 只建模与电源管理 / 链路状态相关的信号，不涉及具体连接器机械结构：
 *  - PRSNT#           插卡在位检测（0 = 在位）
 *  - Power Controller 槽位主电源开关（Slot Control）
 *  - PERST#           Fundamental Reset（上电稳定后释放）
 *  - Attention Button 用户请求安全拔出
 *  - Power Indicator 电源指示灯（on / blink / off）
 *  - DLLSC            数据链路层状态变化（Link Up / Down 时置位）
 */
export class HotPlugModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.presence = 'absent';
    this.powerController = 'off';
    this.powerFault = false;
    this.attention = false;
    this.powerIndicator = 'off';
    this.perst = true;
    this.dllsc = false;
    this.linkUp = false;
    this.interrupts = 0;
    this.inserts = 0;
    this.removals = 0;
  }

  enable() {
    this.enabled = true;
  }

  insert() {
    this.presence = 'present';
    this.inserts += 1;
    this.attention = false;
    this.powerFault = false;
  }

  powerOn() {
    this.powerController = 'on';
    this.powerFault = false;
    this.powerIndicator = 'blink';
  }

  powerOff() {
    this.powerController = 'off';
    this.perst = true;
    this.powerIndicator = 'off';
    this.linkUp = false;
  }

  releasePerst() {
    this.perst = false;
  }

  setLinkUp() {
    this.linkUp = true;
    this.dllsc = true;
    this.powerIndicator = 'on';
  }

  setLinkDown() {
    this.linkUp = false;
    this.dllsc = true;
  }

  pressAttention() {
    this.attention = true;
    this.powerIndicator = 'blink';
  }

  remove() {
    this.presence = 'absent';
    this.removals += 1;
    this.attention = false;
    this.powerIndicator = 'off';
  }

  interrupt() {
    if (!this.enabled) return false;
    this.interrupts += 1;
    return true;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      presence: this.presence,
      powerController: this.powerController,
      powerFault: this.powerFault,
      attention: this.attention,
      powerIndicator: this.powerIndicator,
      perst: this.perst,
      dllsc: this.dllsc,
      linkUp: this.linkUp,
      interrupts: this.interrupts,
      inserts: this.inserts,
      removals: this.removals,
    };
  }
}
