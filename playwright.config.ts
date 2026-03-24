import path from 'path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig, devices } from 'playwright/test';

// Load env before tests so dotenv logs appear before list reporter output
loadDotenv({ path: path.join(__dirname, 'rest/unity/.env') });

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  outputDir: 'test-results/',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    trace: 'on-first-retry',
    // Increase default browser window size for tests
    viewport: { width: 1500, height: 1100 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
