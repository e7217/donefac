import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const cachedBrowser = '/home/sfa/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const externalUrl = process.env.TEAMSPACE_TEST_URL;
const testWebPort = process.env.TEAMSPACE_TEST_WEB_PORT || '5179';
const testApiPort = process.env.TEAMSPACE_TEST_API_PORT || '5189';
const testUrl = `http://127.0.0.1:${testWebPort}`;
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: externalUrl || testUrl,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
    screenshot: 'only-on-failure',
    launchOptions: {
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : existsSync(cachedBrowser) ? { executablePath: cachedBrowser } : {}),
      args: ['--no-sandbox'],
    },
  },
  ...(!externalUrl ? { webServer: {
    command: 'node scripts/browser-test-server.mjs',
    url: `${testUrl}/api/health`,
    env: { TEAMSPACE_TEST_WEB_PORT: testWebPort, TEAMSPACE_TEST_API_PORT: testApiPort },
    reuseExistingServer: false,
    timeout: 130_000,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 12_000 },
  } } : {}),
});
