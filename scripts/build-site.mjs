import { cp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { snapshot } from './snapshot.mjs';

const data = process.env.STATUS_FIXTURE
  ? JSON.parse(await readFile(process.env.STATUS_FIXTURE, 'utf8'))
  : await snapshot(process.env.GH_TOKEN);
if (!data.sites?.length || !data.checkedAt || !data.generatedAt) throw new Error('Incomplete status snapshot');
await rm('site', { recursive: true, force: true });
await cp('node_modules/@upptime/status-page', 'site', { recursive: true });
await mkdir('site/src/data', { recursive: true });
await writeFile('site/src/data/snapshot.json', JSON.stringify(data));
await symlink(resolve('node_modules'), 'site/node_modules', 'dir');
const build = spawnSync('npm', ['run', 'export'], {
  cwd: 'site', stdio: 'inherit', env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true',
    PATH: `${resolve('node_modules/.bin')}:${process.env.PATH}` },
});
if (build.status !== 0) throw new Error('Upptime export failed');
await rm('dist', { recursive: true, force: true });
await cp('site/__sapper__/export', 'dist', { recursive: true });
await cp('assets', 'dist', { recursive: true });
await cp('graphs', 'dist/graphs', { recursive: true });
await writeFile('dist/status.json', JSON.stringify(data));
await writeFile('dist/.nojekyll', '');
