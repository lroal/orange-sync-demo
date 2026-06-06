import { spawnSync } from 'node:child_process';

for (const dir of ['client', 'server']) {
  const result = spawnSync('npm', ['install', '--prefix', dir], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.status !== 0)
    process.exit(result.status ?? 1);
}
