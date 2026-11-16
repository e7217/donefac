import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const cachedBrowser = '/home/sfa/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.TEAMSPACE_TEST_URL || 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
    screenshot: 'only-on-failure',
    launchOptions: {
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : existsSync(cachedBrowser) ? { executablePath: cachedBrowser } : {}),
      args: ['--no-sandbox'],
    },
  },
});
