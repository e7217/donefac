import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const url = new URL(process.env.TEAMSPACE_PILOT_TEST_URL ?? 'http://invalid');
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' ||
  url.username || url.password || url.search || url.hash) {
  throw new Error('Run npm run test:pilot to start an isolated pilot test server.');
}

export default defineConfig({
  ...base,
  testDir: './tests/ops',
  use: { ...base.use, baseURL: url.origin },
  webServer: undefined,
});
