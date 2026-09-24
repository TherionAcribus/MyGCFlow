import { defineConfig, devices } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const port = Number(process.env.MYGCFLOW_E2E_PORT || 5011);
const runtimeDir = process.env.MYGCFLOW_E2E_RUNTIME
  || mkdtempSync(path.join(tmpdir(), 'mygcflow-e2e-'));
const localVenvPython = process.platform === 'win32'
  ? path.resolve('.venv', 'Scripts', 'python.exe')
  : path.resolve('.venv', 'bin', 'python');
const python = process.env.MYGCFLOW_E2E_PYTHON
  || (existsSync(localVenvPython) ? localVenvPython : 'python');

// Rendu visible par les tests et par le script de nettoyage global.
process.env.MYGCFLOW_E2E_RUNTIME = runtimeDir;
process.env.MYGCFLOW_E2E_PYTHON = python;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './output/playwright',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'output/playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'output/playwright-report', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--enable-unsafe-swiftshader',
        '--use-gl=swiftshader',
      ],
    },
  },
  webServer: {
    command: `"${python}" tests/e2e/run_server.py`,
    url: `http://127.0.0.1:${port}/db_status`,
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      MYGCFLOW_E2E_PORT: String(port),
      MYGCFLOW_E2E_RUNTIME: runtimeDir,
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
    },
  },
});
