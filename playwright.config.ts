import { defineConfig, devices } from '@playwright/test'

/**
 * E2E test configuration for the SPA + Go backend stack.
 *
 * Assumptions:
 *   - The backend (Postgres + API) is running before tests start.
 *     Use `npm run e2e:stack` to start it via docker-compose, or run
 *     your own local stack on http://localhost:8080.
 *   - The SPA dev server is started by Playwright's webServer option.
 *
 * All tests share a single worker process so they can safely reuse the
 * default tenant created by global-setup.
 */

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173'
const apiURL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8080'
const apiKey = process.env.PLAYWRIGHT_API_KEY ?? 'dev-api-key-change-in-production'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : [['html', { open: 'never' }], ['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  globalSetup: './e2e/global-setup',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_API_BASE_URL: apiURL,
      VITE_API_KEY: apiKey,
    },
  },
})
