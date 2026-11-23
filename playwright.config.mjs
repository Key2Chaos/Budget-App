// Browser tests: npm run test:e2e
// Locally the phone project uses your installed Microsoft Edge (no download needed).
// On GitHub (CI) it uses Playwright's bundled Chromium, plus WebKit — Safari's engine, closest to iPhone.
// Run WebKit locally with:  npx playwright install webkit  then  E2E_WEBKIT=1 npm run test:e2e
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.mjs',
  timeout: 30_000,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8799/',
    locale: 'en-GB',              // → £ and "12 Nov" style dates, like a UK iPhone
    timezoneId: 'Europe/London',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Always start our own server on a dedicated port, so nothing else running can interfere.
  webServer: {
    command: 'node tests/e2e/serve.mjs',
    env: { PORT: '8799' },
    url: 'http://127.0.0.1:8799/',
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'phone-chromium',
      testIgnore: 'desktop.spec.mjs',
      use: { ...phone, browserName: 'chromium', ...(CI || process.env.E2E_CHROMIUM ? {} : { channel: 'msedge' }) },
    },
    ...(CI || process.env.E2E_WEBKIT ? [{ name: 'iphone-webkit', testIgnore: 'desktop.spec.mjs', use: { ...devices['iPhone 14'] } }] : []),
    // A laptop-sized window: the sidebar and column layout
    {
      name: 'desktop-chromium',
      testMatch: 'desktop.spec.mjs',
      use: { viewport: { width: 1280, height: 800 }, browserName: 'chromium', ...(CI || process.env.E2E_CHROMIUM ? {} : { channel: 'msedge' }) },
    },
  ],
});
