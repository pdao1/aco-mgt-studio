import { spawnSync } from 'node:child_process';

const dockerCommand = process.platform === 'win32' ? 'docker.exe' : 'docker';

const engineCheck = spawnSync(
  dockerCommand,
  ['info', '--format', '{{.ServerVersion}}'],
  {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  },
);

if (engineCheck.error || engineCheck.status !== 0) {
  const timedOut = (engineCheck.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const detail = timedOut
    ? 'Docker did not respond within 15 seconds.'
    : engineCheck.stderr.trim() || engineCheck.error?.message || 'Docker is not available.';

  console.error(`\n${detail}`);
  console.error('Start Docker Desktop and wait for its engine to be ready, then run npm run dev again.');
  process.exit(1);
}

console.info(`Docker ${engineCheck.stdout.trim()} is ready. Starting PostgreSQL...`);

const databaseStart = spawnSync(
  dockerCommand,
  ['compose', 'up', '-d', '--wait', 'database'],
  {
    stdio: 'inherit',
    timeout: 120_000,
  },
);

if (databaseStart.error || databaseStart.status !== 0) {
  const timedOut = (databaseStart.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  console.error(
    timedOut
      ? '\nPostgreSQL did not become healthy within two minutes.'
      : '\nPostgreSQL could not be started.',
  );
  process.exit(1);
}

console.info('PostgreSQL is ready.');
