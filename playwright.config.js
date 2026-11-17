import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8137/pcie-sim/',
    channel: process.env.PCIE_BROWSER_CHANNEL || 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server 8137 --bind 127.0.0.1 --directory ..',
    url: 'http://127.0.0.1:8137/pcie-sim/',
    reuseExistingServer: false,
    stderr: 'ignore',
  },
});
