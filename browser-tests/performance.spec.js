import { expect, test } from '@playwright/test';

test('performance lab opens from the teaching page and runs read/write and Gen6 views', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await page.getByRole('link', { name: /性能实验室/ }).click();
  await expect(page.getByRole('status')).toContainText('已完成');
  await expect(page.locator('#bandwidth')).toContainText(/整批达成率：链路理想 [\d.]+%/);
  await expect(page.getByRole('group', { name: 'PCIe 硬件拓扑' })).toBeVisible();
  await expect(page.locator('#topology [data-node="rc>epA"]')).toHaveAttribute('data-traffic', 'CplD');
  await expect(page.locator('#topology [data-node="epA>rc"]')).toHaveAttribute('data-traffic', 'MRd MWr');
  await expect(page.locator('#topology [data-node="rc>epA"] .wire-direction-arrow')).toHaveCount(1);
  await expect(page.locator('#topology [data-node="rc>epA"] .wire-end-label')).toHaveText(['TX', 'RX']);
  await expect(page.locator('#topology [data-node="epA>rc"] .wire-end-label')).toHaveText(['RX', 'TX']);
  await expect(page.locator('[data-rtt-link="epA>rc"]')).toHaveText('t₀');
  await expect(page.locator('[data-rtt-link="rc>epA"]')).toHaveText('tCpl');
  await expect(page.locator('#metric-map')).toContainText('RTT 首片 / 末片 P50');
  await page.locator('#topology [data-node="host.DDR"]').first().click();
  await expect(page.locator('#node-detail')).toContainText('峰值');
  await expect(page.getByRole('dialog')).toContainText('host.DDR');
  await page.getByRole('button', { name: '关闭事件浮窗' }).click();
  await expect(page.locator('#node-detail')).toContainText('L₀=');
  await page.getByLabel('操作', { exact: true }).selectOption('flow1:1');
  await expect(page.locator('#txn-stops')).toContainText('目标可见');
  const visiblePin = page.getByRole('button', { name: /里程碑 .*目标可见/ });
  await visiblePin.click();
  await expect(page.locator('#txn-focus')).toContainText('host.DDR · 写入目标可见');
  await expect(visiblePin).toHaveClass(/current/);
  await expect(visiblePin).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#timeline-card')).toHaveAttribute('open', '');
  await expect(page.locator('#timeline .trace-selected')).toContainText('写入目标可见 · host.DDR');
  await expect(page.locator('.trace-group[data-phase="target"]')).toHaveAttribute('open', '');
  await expect(page.locator('.trace-group[data-phase="request"]')).not.toHaveAttribute('open', '');
  await page.locator('#txn-stops').getByRole('button', { name: /业务提交/ }).click();
  await expect(page.locator('#timeline .trace-selected')).toContainText('业务提交');
  await expect(page.locator('.trace-group[data-phase="issue"]')).toHaveAttribute('open', '');
  await expect(visiblePin).toHaveAttribute('aria-pressed', 'false');
  await page.getByLabel('记录视图').selectOption('rtt');
  await expect(page.locator('#rtt-static-summary')).toContainText('没有可完整重建的 MRd');
  await page.getByLabel('操作', { exact: true }).selectOption('flow1:0');
  await expect(page.locator('.rtt-rulers [data-phase]')).toHaveCount(4);
  for (const id of ['A', 'B', 'C', 'D', 'E']) {
    await expect(page.locator(`[data-rtt-point="${id}"]`)).toHaveCount(2);
    await expect(page.locator(`[data-guide="${id}"]`)).toHaveAttribute('d', /V485$/);
  }
  await expect(page.locator('#rtt-static-summary')).toContainText('末片 RTT');
  await expect(page.locator('#timeline-card')).toBeHidden();
  await page.getByLabel('记录视图').selectOption('events');
  await expect(page.locator('.rtt-rulers [data-phase]')).toHaveCount(0);
  await page.getByLabel('读写配比（字节）').selectOption('0');
  await page.getByRole('button', { name: '运行模型' }).click();
  await expect(page.getByRole('status')).toContainText('已完成');
  await expect(page.locator('#topology [data-node="rc>epA"]')).toHaveAttribute('data-traffic', '');
  await expect(page.locator('#topology [data-node="epA>rc"]')).toHaveAttribute('data-traffic', 'MWr');
  await expect(page.locator('[data-rtt-link]')).toHaveCount(0);
  await page.getByLabel('速率').selectOption('6');
  await page.getByRole('button', { name: '运行模型' }).click();
  await expect(page.getByRole('status')).toContainText('Gen6 解析预算');
  await expect(page.locator('#bandwidth')).toContainText('当前无可比整批结果');
  await expect(page.locator('#timeline-card')).toBeHidden();
  await expect(page.locator('#playback')).toBeHidden();
  expect(errors).toEqual([]);
});

test('single Completion RTT shares one hardware and time endpoint for first and last', async ({ page }) => {
  await page.goto('performance.html');
  await page.getByLabel('访问路径').selectOption('cpu-bar');
  await page.getByRole('button', { name: '运行模型' }).click();
  await expect(page.getByRole('status')).toContainText('已完成');
  await page.getByLabel('记录视图').selectOption('rtt');
  await expect(page.locator('[data-rtt-point="D"]')).toHaveCount(2);
  await expect(page.locator('[data-rtt-point="E"]')).toHaveCount(0);
  await expect(page.locator('[data-phase="tail"]')).toContainText('D → D');
  await expect(page.locator('[data-phase="tail"] .rtt-measure')).toHaveCount(0);
});

test('topology playback steps through MRd and CplD and filters the data layer', async ({ page }) => {
  await page.goto('performance.html');
  await expect(page.getByRole('status')).toContainText('已完成');
  const overlay = page.locator('.flow-overlay');
  const callout = page.getByTestId('step-callout');
  const step = page.getByRole('button', { name: '下一事件' });
  await expect(callout).toContainText('第 1/');
  await expect(page.locator('[data-node="epA.CTL"]')).toContainText('Tag 32');
  await expect(page.locator('[data-node="epA.AXI"]')).toContainText('R/W 并发 32/32');
  await expect(page.locator('[data-node="host.CMN"]')).toContainText('64 GB/s');
  await page.locator('details').filter({ hasText: '调整节点与负载参数' }).first().click();
  await page.getByLabel('CMN 系统互连（GB/s）').fill('8');
  await page.getByRole('button', { name: '运行模型' }).click();
  await expect(page.getByRole('status')).toContainText('已完成');
  await expect(page.locator('[data-node="host.CMN"]')).toContainText('8 GB/s');
  await step.click();
  await expect(callout).toContainText('第 2/');
  await page.locator('#prev-flow').click();
  await expect(callout).toContainText('第 1/');
  await page.getByLabel('流量层').selectOption('control');
  const request = overlay.locator('[data-packet="NP"][data-resource="epA>rc"]');
  for (let index = 0; index < 40 && !await request.count(); index++) await step.click();
  await expect(request.first()).toBeVisible();
  await page.getByLabel('流量层').selectOption('data');
  await expect(overlay.locator('[data-packet="NP"]')).toHaveCount(0);
  const completion = overlay.locator('[data-packet="Cpl"][data-resource="rc>epA"]');
  for (let index = 0; index < 70 && !await completion.count(); index++) await step.click();
  await expect(completion.first()).toBeVisible();
  await page.getByRole('button', { name: '回到起点' }).click();
  await expect(page.locator('#flow-clock')).toHaveValue('0');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
});

test('duplex P2P renders shared wires and exports results on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.goto('performance.html');
  await page.getByLabel('访问路径').selectOption('duplex');
  await expect(page.getByLabel('读写配比（字节）')).toBeDisabled();
  await page.getByRole('button', { name: '运行模型' }).click();
  await expect(page.getByRole('status')).toContainText('已完成');
  const shared = page.getByRole('button', { name: 'EP A → Switch', exact: true });
  await expect(shared).toHaveAttribute('data-traffic', 'CplD MWr');
  await expect(page.locator('[data-rtt-link="epB>sw"]')).toHaveText('t₀·flow2');
  await expect(page.locator('[data-rtt-link="sw>epB"]')).toHaveText('tCpl·flow2');
  await expect(page.locator('#topology [data-node="host.DDR"]')).toHaveCount(0);
  await shared.focus();
  await shared.press('Enter');
  await expect(page.locator('#node-detail')).toContainText('线流量');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '关闭事件浮窗' }).click();
  await expect(page.locator('#links')).toContainText('EP A → Switch');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出结果 JSON' }).click();
  expect((await downloadEvent).suggestedFilename()).toBe('pcie-performance.json');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('link inspector browses traced events, shows per-fragment RTT, and seeks playback', async ({ page }) => {
  await page.goto('performance.html');
  await expect(page.getByRole('status')).toContainText('已完成');
  await page.getByRole('button', { name: 'RP → EP A', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const picker = dialog.getByLabel('选择事件');
  const rtt = picker.getByRole('option', { name: /CplD 抵达 · RTT 测量点/ }).first();
  await picker.selectOption(await rtt.getAttribute('value'));
  await expect(dialog.locator('#inspect-event')).toContainText('该片 RTT');
  await expect(dialog.locator('#inspect-event')).toContainText('Requester / Tag');
  await dialog.getByRole('button', { name: '下一步' }).click();
  await dialog.getByRole('button', { name: '上一步' }).click();
  await expect(dialog.locator('#inspect-event')).toContainText('该片 RTT');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#flow-clock')).not.toHaveValue('0');
});

test('RC Bridge 分层显示 AXI 物理峰值与桥接器有效上限', async ({ page }) => {
  await page.goto('./performance.html');
  // 默认 Gen4 ×8：256 bit × 1 GHz = 32 GB/s
  await expect(page.locator('#rc-axi-preset')).toContainText('256 bit × 1 GHz = 32 GB/s 物理峰值');
  await page.getByLabel('速率').selectOption('6');
  await page.getByLabel('链路宽度').selectOption('16');
  // Gen6 ×16：1024 bit × 1 GHz = 128 GB/s 物理峰值，预设有效上限与链路一致（128 GB/s）
  await expect(page.locator('#rc-axi-preset')).toContainText('1024 bit × 1 GHz = 128 GB/s 物理峰值');
  await expect(page.locator('#rc-axi-preset')).toContainText('Bridge 有效上限 128 GB/s');
  await expect(page.locator('input[name="rcAxiWidthBits"]')).toHaveValue('1024');
  await expect(page.locator('input[name="rcAxiClockGHz"]')).toHaveValue('1');
  await expect(page.locator('input[name="rcBridgeBandwidthGBps"]')).toHaveValue('128');

  await page.getByRole('button', { name: '运行模型' }).click();
  await expect(page.getByRole('status')).toContainText('Gen6 解析预算');
  await expect(page.locator('#ideal-calculation')).toContainText('1024 bit × 1 GHz = 128 GB/s 物理峰值');
  await expect(page.locator('#ideal-calculation')).toContainText('桥接器有效上限 128 GB/s');

  // 手动把宽度改小：物理峰值 32 GB/s 低于有效上限 128 GB/s，必须报错而不是静默通过
  await page.locator('input[name="rcAxiWidthBits"]').evaluate(el => { el.value = '256'; });
  await page.getByRole('button', { name: '运行模型' }).click();
  await expect(page.getByRole('status')).toContainText('无法计算');
});

test('公式与计量边界包含符号定义、单位与物理含义', async ({ page }) => {
  await page.goto('./performance.html');
  const details = page.locator('details.metric-formulas');
  await details.locator('summary').click();
  await expect(details).toContainText('符号定义');
  await expect(details.locator('.formula-block table')).toContainText('业务有效字节');
  await expect(details.locator('.formula-block table')).toContainText('物理含义');
  await expect(details.locator('.formula-block table')).toContainText('桥接器有效上限');
  await expect(details).toContainText('Cℓ = GT/s × Lanes / 8 × η');
  await expect(details).toContainText('P_axi = W_axi / 8 × f_axi');
  await expect(details).toContainText('B_ideal = V / maxℓ Tℓ');
  await expect(details).toContainText('计量边界');
  await expect(details).toContainText('半开区间');
});
