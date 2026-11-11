import { defineConfig, devices } from '@playwright/test';

/**
 * Testes E2E (caixa-preta) contra a stack do Docker Compose já no ar:
 *   docker compose up -d --build
 *   bun run test:e2e
 *
 * Três réplicas: E2E_URLS (padrão http://127.0.0.1:3000,3001,3002). IPv4 explícito: no Windows,
 * "localhost" pode resolver para ::1 e passar pelo wslrelay do WSL, que é instável sob carga.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  use: {
    baseURL: (process.env.E2E_URLS ?? 'http://127.0.0.1:3000').split(',')[0],
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'api', testMatch: /api\..*\.spec\.ts/ },
    { name: 'ui', testMatch: /ui\..*\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ],
});
