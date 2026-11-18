import { defineConfig, devices } from '@playwright/test';

// 本地默认用系统 Chrome（PCIE_BROWSER_CHANNEL=chrome）；
// CI 用 Playwright 自带浏览器并跑 Chromium / Firefox / WebKit 三套。
const channel = process.env.PCIE_BROWSER_CHANNEL || '';
const only = process.env.PCIE_BROWSER_PROJECT || '';
const viewport = { width: 1440, height: 1000 };

const projects = [
  {
    name: 'chromium',
    use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}), viewport },
  },
  { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport } },
  { name: 'webkit', use: { ...devices['Desktop Safari'], viewport } },
];

export default defineConfig({
  testDir: './browser-tests',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8137/pcie-sim/',
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: only ? projects.filter((p) => p.name === only) : projects,
  webServer: {
    command: 'python3 -m http.server 8137 --bind 127.0.0.1 --directory ..',
    url: 'http://127.0.0.1:8137/pcie-sim/',
    reuseExistingServer: false,
    stderr: 'ignore',
  },
});
