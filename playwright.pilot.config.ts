import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const url = new URL(process.env.DONEFAC_PILOT_TEST_URL ?? 'http://invalid');
const team = Boolean(process.env.DONEFAC_PILOT_TEAM_FIXTURE);
if (url.protocol !== (team ? 'https:' : 'http:') || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' ||
  url.username || url.password || url.search || url.hash) {
  throw new Error('Run npm run test:pilot or npm run test:pilot:team to start an isolated pilot test server.');
}

export default defineConfig({
  ...base,
  testDir: team ? './tests/team-pilot' : './tests/ops',
  testMatch: '**/*.spec.ts',
  use: {
    ...base.use,
    baseURL: url.origin,
    ...(team ? { trace: 'off', screenshot: 'off', video: 'off' } as const : {}),
  },
  webServer: undefined,
});
