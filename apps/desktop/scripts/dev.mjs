import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * `npm run dev` — one command instead of juggling terminals.
 *
 * Compiles the main process, bundles the preload, starts the Vite dev server, waits for
 * it to answer, then launches Electron pointed at it. Electron exiting tears the whole
 * thing down. No extra dependencies: everything here is node:child_process.
 */

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 150;

/** @type {import('node:child_process').ChildProcess | null} */
let viteProcess = null;
let shuttingDown = false;

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @returns {import('node:child_process').ChildProcess}
 */
function launch(command, args, extraEnv) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: extraEnv === undefined ? process.env : { ...process.env, ...extraEnv },
  });

  child.on('error', (error) => {
    const reason =
      'code' in error && error.code === 'ENOENT'
        ? `"${command}" was not found on PATH. Run this through "npm run dev" so npm adds node_modules/.bin.`
        : error.message;
    console.error(`[matchline:dev] ${reason}`);
    void shutdown(1);
  });

  return child;
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {Promise<void>}
 */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = launch(command, args);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${String(code)}`));
      }
    });
  });
}

/** @returns {Promise<void>} */
async function waitForDevServer() {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (shuttingDown) {
      return;
    }
    try {
      const response = await fetch(DEV_SERVER_URL, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch {
      // Server not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, SERVER_POLL_INTERVAL_MS));
  }

  throw new Error(`Vite dev server did not answer on ${DEV_SERVER_URL} within 30s.`);
}

/**
 * @param {number} code
 * @returns {Promise<never>}
 */
async function shutdown(code) {
  if (!shuttingDown) {
    shuttingDown = true;
    if (viteProcess !== null && viteProcess.exitCode === null) {
      viteProcess.kill('SIGTERM');
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => {
  void shutdown(0);
});
process.on('SIGTERM', () => {
  void shutdown(0);
});

try {
  console.log('[matchline:dev] compiling main process and preload…');
  await run('tsc', ['-b']);
  await run('vite', ['build', '--config', 'vite.preload.config.ts']);

  console.log('[matchline:dev] starting Vite dev server…');
  viteProcess = launch('vite', ['--port', String(DEV_SERVER_PORT), '--strictPort']);
  await waitForDevServer();

  console.log('[matchline:dev] launching Electron…');
  const electronProcess = launch('electron', ['.'], {
    MATCHLINE_DEV_SERVER_URL: DEV_SERVER_URL,
  });
  electronProcess.on('close', (code) => {
    void shutdown(code ?? 0);
  });
} catch (error) {
  console.error(`[matchline:dev] ${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
}
