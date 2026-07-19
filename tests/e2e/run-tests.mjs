import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';


const runtime = mkdtempSync(path.join(tmpdir(), 'gcmap-e2e-'));
const playwrightCli = path.resolve('node_modules', '@playwright', 'test', 'cli.js');
const args = ['test', ...process.argv.slice(2)];


function runPlaywright() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, GCMAP_E2E_RUNTIME: runtime },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}


function cleanupOwnedRuntime() {
  if (process.env.GCMAP_E2E_KEEP_RUNTIME === '1' || !existsSync(runtime)) return;

  const resolved = realpathSync(runtime);
  const tempRoot = realpathSync(tmpdir());
  const marker = path.join(resolved, '.gcmap-e2e-runtime');
  const isOwnedRuntime = existsSync(marker)
    && path.dirname(resolved) === tempRoot
    && path.basename(resolved).startsWith('gcmap-e2e-');
  if (!isOwnedRuntime) return;

  // Playwright a déjà arrêté son webServer à ce stade. Quelques
  // antivirus Windows gardent toutefois SQLite ouvert un court instant.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(resolved, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) {
        console.warn(`Runtime E2E conservé faute de pouvoir le supprimer : ${resolved} (${error.message})`);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}


let result;
try {
  result = await runPlaywright();
} finally {
  cleanupOwnedRuntime();
}

if (result.signal) {
  console.error(`Playwright interrompu par le signal ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.code ?? 1;
}
