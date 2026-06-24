import { spawn } from 'node:child_process';

const useSahPool = !process.argv.includes('--opfs');
const useBigDb = process.argv.includes('--big');

const commands = [
  ['server', ['run', 'dev', '--prefix', 'server']],
  ['client', ['run', 'dev', '--prefix', 'client'], getClientEnv()]
];

const children = commands.map(([name, args, env]) => {
  const child = spawn('npm', args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, ...env }
  });

  child.stdout.on('data', (chunk) => writePrefixed(name, chunk));
  child.stderr.on('data', (chunk) => writePrefixed(name, chunk));
  child.on('exit', (code, signal) => {
    if (shuttingDown)
      return;
    shuttingDown = true;
    stopChildren();
    process.exit(code ?? (signal ? 1 : 0));
  });

  return child;
});

let shuttingDown = false;

process.on('SIGINT', () => {
  shuttingDown = true;
  stopChildren();
});

process.on('SIGTERM', () => {
  shuttingDown = true;
  stopChildren();
});

function stopChildren() {
  for (const child of children) {
    if (!child.killed)
      child.kill('SIGTERM');
  }
}

function writePrefixed(name, chunk) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line)
      process.stdout.write(`[${name}] ${line}\n`);
  }
}

function getClientEnv() {
  const modeEnv = useBigDb
    ? {
        VITE_BIG_MODE: '1',
        VITE_SQLITE_DB_NAME: process.env.VITE_SQLITE_DB_NAME || 'orange-sync-demo-big2.sqlite3',
        VITE_BIG_PROJECTS: process.env.VITE_BIG_PROJECTS || '5000',
        VITE_BIG_TASKS_PER_PROJECT: process.env.VITE_BIG_TASKS_PER_PROJECT || '3'
      }
    : {};

  if (!useSahPool) {
    return {
      ...modeEnv,
      VITE_SQLITE_OPFS_VFS: '',
      VITE_SQLITE_OPFS_SAH_FALLBACK: ''
    };
  }

  return {
    ...modeEnv,
    VITE_SQLITE_OPFS_VFS: process.env.VITE_SQLITE_OPFS_VFS || 'opfs-sahpool',
    VITE_SQLITE_OPFS_SAH_FALLBACK: process.env.VITE_SQLITE_OPFS_SAH_FALLBACK || '1'
  };
}
