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
