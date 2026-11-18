import { test, expect } from '@playwright/test';

const scenarios = [
  'link_training', 'enumeration', 'ltssm_pm', 'phy_link', 'flit_gen6',
  'loopback_bert', 'mem_read', 'mem_write', 'msi_int', 'aer_error',
  'dpc_rpio', 'ats', 'pm_dp',
];
for (const scenario of scenarios) {
  test(`子路径加载、单步/回退/复位：${scenario}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.goto('./');
    await page.locator('#scenario').selectOption(scenario);
    if (scenario === 'flit_gen6') await expect(page.locator('#gen')).toHaveValue('6');
    await expect(page.locator('#step')).toBeEnabled();
    await page.locator('#step').click();
    await page.locator('#step').click();
    const before = await page.locator('#status').textContent();
    await page.locator('#back').click();
    await page.locator('#step').click();
    await expect(page.locator('#status')).toHaveText(before);
    await page.locator('#viewFlow').click();
    await page.locator('#viewTimeline').click();
    await page.locator('#reset').click();
    await expect(page.locator('#capabilityNote')).toContainText('生效');
    await expect(page.locator('#status')).toContainText('可回退');
    if (scenario === 'link_training') await page.screenshot({ path: 'docs/M1-browser.png' });
    expect(errors).toEqual([]);
  });
}

test('Gen6 切入 NFM 场景自动收敛到最近合法配置并继续播放', async ({ page }) => {
  await page.goto('./');
  await page.locator('#gen').selectOption('6');
  await page.locator('#scenario').selectOption('mem_read');
  await expect(page.locator('#gen')).toHaveValue('5');
  await expect(page.locator('#capabilityNote')).toContainText('已自动调整');
  await expect(page.locator('#capabilityNote')).toContainText('生效');
  await expect(page.locator('#run')).toBeEnabled();
  await expect(page.locator('#step')).toBeEnabled();
  await page.locator('#step').click();
  await expect(page.locator('#status')).toContainText('可回退');
});

test('模式与场景不兼容时自动切换为自动模式', async ({ page }) => {
  await page.goto('./');
  await page.locator('#mode').selectOption('flit');
  await expect(page.locator('#capabilityNote')).toContainText('Flit');
  await page.locator('#scenario').selectOption('phy_link');
  await expect(page.locator('#mode')).toHaveValue('auto');
  await expect(page.locator('#capabilityNote')).toContainText('已自动调整');
  await expect(page.locator('#run')).toBeEnabled();
  await expect(page.locator('#step')).toBeEnabled();
});

test('导引可打开并用 Esc 关闭', async ({ page }) => {
  await page.goto('./');
  await page.locator('#guideBtn').click();
  await expect(page.locator('#modalTitle')).toHaveText('场景导引');
  await expect(page.locator('.guide-section').first()).toBeVisible();
  await expect(page.locator('.guide-list').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#eventModal')).toBeHidden();
});

test('事件筛选按层过滤并显示计数', async ({ page }) => {
  await page.goto('./');
  await page.locator('#scenario').selectOption('mem_read');
  // 推进到出现 TLP/Completion 事件，确保 TL 层有内容
  for (let i = 0; i < 14; i += 1) {
    const step = page.locator('#step');
    if (!(await step.isEnabled())) break;
    await step.click();
  }
  const total = Number(await page.locator('#timeline').getAttribute('data-total'));
  expect(total).toBeGreaterThan(1);
  await page.locator('#filterLayer').selectOption('TL');
  const visible = Number(await page.locator('#timeline').getAttribute('data-visible'));
  expect(visible).toBeGreaterThan(0);
  expect(visible).toBeLessThan(total);
  await expect(page.locator('#filterCount')).toContainText('显示');
  await page.locator('#filterClear').click();
  await expect(page.locator('#filterCount')).toHaveText('');
  await expect(page.locator('#timeline')).toHaveAttribute('data-visible', String(total));
});

test('URL 状态恢复场景与配置', async ({ page }) => {
  await page.goto('./#scenario=mem_read&gen=5&width=4&mode=nonflit');
  await expect(page.locator('#scenario')).toHaveValue('mem_read');
  await expect(page.locator('#gen')).toHaveValue('5');
  await expect(page.locator('#width')).toHaveValue('4');
  await expect(page.locator('#mode')).toHaveValue('nonflit');
  await expect(page.locator('#step')).toBeEnabled();
});
