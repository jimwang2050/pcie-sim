# 协议参考与升级追溯表

日期：2026-11-17；用途：为 [升级计划](UPGRADE_PLAN_2026-11-17.md) 提供本地资料定位。此文件是开发阅读索引，不应原样发布到网页。

## 资料版本

| 代号 | 本地目录 | 记录到的 Git HEAD | 用法 |
| --- | --- | --- | --- |
| S62 | `/Users/jianmingwang/Downloads/00_study/02_work/01_book/pcie_cxl/PCIe6.2_zh` | `24ee004dc677155b2e60fd88725d09f7f4a02851` | PCIe Base 6.2 v1.0，2024-01-25，中英对照；规范性依据 |
| MS3 | `/Users/jianmingwang/Downloads/00_study/02_work/01_book/pcie_cxl/MindShare_PCIe_Technology_3.0_mineru_v2` | `afdb96d40509a29ef86167db94d71f7181d66230` | 经典架构、Non-Flit/Gen1–3 教学解释 |

HEAD 仅标识读取时仓库提交，不证明工作区全部文件与提交一致；执行 WP00 时记录实际引用文件 hash。两个资料库本轮均未写入。

## 文件缩写

- S62/C2：`PCIe6.2_Spec_ch02_Transaction_Layer_Specification_事务层规范.md`
- S62/C3：`PCIe6.2_Spec_ch03_Data_Link_Layer_Specification_数据链路层规范.md`
- S62/C4：`PCIe6.2_Spec_ch04_Physical_Layer_Logical_Block_物理层逻辑块.md`
- S62/C5：`PCIe6.2_Spec_ch05_Power_Management_电源管理.md`
- S62/C6：`PCIe6.2_Spec_ch06_System_Architecture_系统架构.md`
- S62/C7A：`PCIe6.2_Spec_ch07_软件初始化与配置_Part_A_7_1-7_8.md`
- S62/C7B：`PCIe6.2_Spec_ch07_软件初始化与配置_Part_B_7_9-7_30.md`
- S62/C8：`PCIe6.2_Spec_ch08_Electrical_Sub_Block_电气子块.md`
- S62/C10：`PCIe6.2_Spec_ch10_Address_Translation_Services_地址转换服务ATS.md`

## 规则到改造的映射

“已核对”指本轮阅读相关正文/条款，不表示模块已经改造或全部规则均已审完。“待逐项核对”是实施前必须完成的协议核查任务。

| 规则 ID | 主题与资料定位 | 当前定位/核查状态 | 工作包 | 预期回归 |
| --- | --- | --- | --- | --- |
| TL-01 | S62/C2 §2.2.1.1、§2.2.7.1；MS3 Ch05 §5.2.9–5.2.10 | NFM 请求布局、Cfg 长度；已核对 MS3 表及现有代码，实施补原图核验 | WP02 | 3DW/4DW、Cfg0/1 独立字段向量 |
| TL-02 | S62/C2 §2.2.5.1/§2.2.5.2；MS3 Ch05 §5.2.5.5–5.2.5.6 | NFM/FM 字节使能分开；条款已定位 | WP02/12 | 1 DW、多 DW、部分字节与非法输入 |
| TL-03 | S62/C2 §2.2.9、§2.3.1.1；MS3 Ch05 §5.2.11–5.2.14 | Byte Count 含当前包，已核对 C2:9411 起；0=4096 见 C2:7524 | WP02/05 | 128→64，Lower Address、累计数据、错误 Completion |
| TL-04 | S62/C2 §2.2.1.2、§2.2.7.2、§2.2.9.2 | FM 头不复用 NFM 编码；已定位，详细向量待建 | WP04/06/12 | FM/NFM 不混用，所支持 FM 格式独立向量 |
| FC-01 | S62/C2 §2.6.1、§2.6.1.1；S62/C3 §3.4.1；MS3 Ch06 | 信用准入、跟踪、归还；模式差异已核对初始化条款 | WP05 | 原子扣减、阻塞恢复、不重复归还 |
| FC-02 | S62/C3 §3.4.1、§3.4.2 | Dedicated/Shared、Scaled FC；C3:730、881 明确 FM InitFC | WP04/05/12 | 不以“FM 禁止 DLLP”作断言；未实现项标明 |
| DL-01 | S62/C3 §3.6.2/§3.6.3；MS3 Ch09/Ch10 | NFM LCRC、序列号、Ack/Nak；待建立独立状态测试 | WP05/11 | Ack 与事务完成分开，重复包/重放 |
| FM-01 | S62/C4 §4.2.3.4.1/§4.2.3.4.2 | TLP/DLP 分区与 DLP 位域；已定位 | WP06/12 | 分区准确，示意与真实字节分开 |
| FM-02 | S62/C4 §4.2.3.4.2.1 及其 .1–.7 子节 | Flit 握手、序号、Ack/Nak/Discard、Replay；细则待逐项核对 | WP06/12 | 重放不重复事务副作用，事件原因可解释 |
| FM-03 | S62/C4 §4.2.3.4.3（C4:6608 起） | 已核对 242 B→8 B CRC、GF(2^8) 机制与附录 K 要求 | WP06/12 | 不用 CRC-32+反码，真实实现匹配独立向量 |
| FM-04 | S62/C4 §4.2.3.4.4（C4:6670 起及续节）；C4:6627 起相关说明 | 已核对三路交织及符号级纠错；参考 RTL 指向附录 J | WP06/12 | 分组/错误分布测试，FEC 后 CRC |
| CFG-01 | S62/C7A §7.5.1.1.1–.4 | ID/Command/Status 定位已核对；逐位访问表待建 | WP03 | RO、16 位写、RW1C、相邻寄存器保护 |
| CFG-02 | S62/C7A §7.5.1.2.1（C7A:3170 起）；MS3 Ch03/Ch04 | BAR 正文与布局定位；位域向量待建 | WP03 | 属性保留、探测、64 位精度、Decode Enable |
| ORD-01 | S62/C2 §2.4.1；MS3 Ch08 | 排序规则与教学示例；条款已定位，矩阵待逐项核对 | WP05/09 | P/NP/Cpl、RO/IDO 前提、生产者—消费者 |
| PHY-01 | S62/C4 §4.2.6；MS3 Ch11/12/14 | LTSSM、NFM 编码/训练；子状态条件待审 | WP07 | 合法迁移、速率变化、超时示意标签 |
| PHY-02 | S62/C4 §4.2.3.1.1；S62/C8；MS3 Ch13 | 已核对 PAM4/FBER 目标语境；电气数值待审 | WP07 | BERT 不用单一 BER 门限冒充所有代际合规 |
| PM-01 | S62/C5；C4 §4.2.6.6/§4.2.6.7；MS3 Ch16 | L0s/L0p/L1/D 状态与唤醒；待逐项核对 | WP07 | 模式约束、状态/资源/唤醒一致 |
| IRQ-01 | S62/C6 §6.1.4；MS3 Ch17；C7A/C7B 对应能力寄存器 | MSI/MSI-X 行为章节已定位，掩码/Pending 规则待审 | WP08 | Enable/Mask/Pending/解除屏蔽及向量范围 |
| RAS-01 | S62/C6 §6.2；C7B 对应 AER/DPC 扩展能力；MS3 Ch15 | AER 章节已定位，DPC 触发/清除位与 RP PIO 条件待核对 | WP08 | Status/Mask/Severity 分离，Posted 不错误完成 |
| ATS-01 | S62/C10 §10.2/§10.3/§10.4/§10.5 | 翻译、失效、PRI 与配置已定位，细则待核对 | WP08 | ATC 失效、响应/请求关联、未支持路径 |
| SIM-01 | 项目自身状态契约；非 PCIe 条款 | 回退污染、过去事件复现已完成 | WP01 | 任意保留步骤的完整状态/事件重放 |
| STAT-01 | 产品统计方法；非 PCIe 统一合规门限 | 零采样 PASS 已复现 | WP07 | 零/少样本、零/非零错误、置信区间 |

## 附录资料缺口

S62/C4 明确引用附录 J 的 FEC 示例 RTL 与附录 K 的 CRC 生成矩阵/代码。当前目录清单主要为 C1–C12；本轮未定位附录 J/K 正文。`raw/chapter_04_raw.md` 中存在引用，不等于附录内容已具备。

WP12 开始前应定位合法可用的对应附录或等效可验证资料，固定版本并得到独立向量。若需要阅读 PDF 原图，再按 PDF 工作流读取；本轮使用现有 Markdown，没有重新提取或修改原书。

## 使用限制与实施记录

- 表中的行号是本地当前文件定位，后续修改可能变化；以章节号、文件 hash、短定位文本共同追溯。
- 本表不复制大段书籍正文。公开页面仅展示少量规则摘要、出处与项目自绘图。
- 具体测试名称、向量数和通过结果在实施中补齐；本计划没有虚构尚未执行的校验。
