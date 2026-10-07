import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { github, pages, safeComment } from './snapshot.mjs';

const directory = await mkdtemp(`${tmpdir()}/agio-upptime-test-`);
const packageRoot = 'node_modules/@upptime/status-page';
const config = { path: '/', owner: 'agio-digital', repo: 'agio-status' };
const data = {
  generatedAt: '2026-10-07T03:00:00Z', checkedAt: '2026-10-07T02:58:00Z', monitorSucceeded: true,
  sites: [{ slug: 'api', status: 'up' }],
  issues: [{ number: 1, state: 'open', labels: [{ name: 'status' }, { name: 'api' }] },
    { number: 2, state: 'closed', labels: [{ name: 'maintenance' }] }],
  comments: { 1: [{ body: 'Update' }] }, commits: { api: [{ commit: { message: '200ms' } }] },
};
async function loadModule(path, replacements) {
  let source = await readFile(`${packageRoot}/${path}`, 'utf8');
  for (const [before, after] of replacements) source = source.replace(before, after);
  const file = `${directory}/${path.replaceAll('/', '-')}.mjs`;
  await writeFile(file, source);
  return import(pathToFileURL(file).href);
}
const adapter = await loadModule('src/utils/createOctokit.js', [
  ['import config from "../data/config.json";', `const config = ${JSON.stringify(config)};`],
  ['import { data } from "./snapshot";', `const data = ${JSON.stringify(data)};`],
]);
const freshness = await loadModule('src/utils/snapshot.js', [
  ['import { writable } from "svelte/store";', `import { writable } from ${JSON.stringify(pathToFileURL(`${process.cwd()}/node_modules/svelte/store/index.mjs`).href)};`],
  ['import data from "../data/snapshot.json";', `const data = ${JSON.stringify(data)};`],
]);

test('upstream component API preserves incident state and all service labels', async () => {
  const api = adapter.createOctokit();
  assert.equal((await api.issues.listForRepo({ state: 'open', labels: 'status,api' })).data[0].number, 1);
  assert.deepEqual((await api.issues.listForRepo({ state: 'closed', labels: 'status' })).data, []);
  assert.equal((await api.issues.listForRepo({ state: 'closed', labels: 'maintenance' })).data[0].number, 2);
  assert.equal((await api.issues.get({ issue_number: '1' })).data.number, 1);
  await assert.rejects(api.issues.get({ issue_number: 999 }));
});
test('graph and comment reversal cannot mutate the published snapshot', async () => {
  const api = adapter.createOctokit();
  const comments = (await api.issues.listComments({ issue_number: 1 })).data;
  comments.pop();
  assert.equal((await api.issues.listComments({ issue_number: 1 })).data.length, 1);
  const commits = (await api.repos.listCommits({ path: 'history/api.yml' })).data;
  commits.pop();
  assert.equal((await api.repos.listCommits({ path: 'history/api.yml' })).data.length, 1);
  await assert.rejects(api.repos.listCommits({ path: 'history/../../secret.yml' }));
});
test('freshness uses monitoring and publication timestamps', () => {
  assert.equal(freshness.isFresh(Date.parse('2026-10-07T03:02:00Z')), true);
  assert.equal(freshness.isFresh(Date.parse('2026-10-07T03:19:00Z')), false);
  assert.equal(freshness.isFresh(Date.parse('2026-10-07T02:00:00Z')), false);
  freshness.data.monitorSucceeded = false;
  assert.equal(freshness.isFresh(Date.parse('2026-10-07T03:02:00Z')), false);
});
test('patched browser data layer has no GitHub requests or visitor token storage', async () => {
  for (const path of ['src/utils/createOctokit.js', 'src/utils/snapshot.js', 'src/components/LiveStatus.svelte', 'src/components/Summary.svelte', 'src/routes/rate-limit-exceeded.svelte']) {
    const source = await readFile(`${packageRoot}/${path}`, 'utf8');
    assert.doesNotMatch(source, /fetch\(|personal-access-token|localStorage|new Octokit/);
  }
  const active = await readFile(`${packageRoot}/src/components/ActiveIncidents.svelte`, 'utf8');
  assert.match(active, /!loading && \$fresh && data.sites.every/);
});
test('public incident comments remove scripts, event handlers and dangerous links', () => {
  const value = safeComment({ body: '<img src=x onerror=alert(1)><script>alert(1)</script> [bad](javascript:alert) **Resolved**', user: { login: '<img>', html_url: 'javascript:alert(1)' }, html_url: 'javascript:alert(1)' });
  assert.doesNotMatch(value.body, /script|onerror|javascript:/);
  assert.match(value.body, /<strong>Resolved<\/strong>/);
  assert.equal(value.user.login, 'img');
  assert.match(value.html_url, /^https:\/\/github.com\//);
});
test('GitHub failures stop publication instead of synthesizing no incidents', async () => {
  await assert.rejects(github('issues', 'test-secret', async () => ({ ok: false, status: 403 })), /HTTP 403/);
  await assert.rejects(github('issues', ''), /token required/);
});
test('snapshot pagination preserves updates across pages and confines authentication to build', async () => {
  const calls = [];
  const result = await pages('issues?state=all', 'test-secret', async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization });
    return { ok: true, json: async () => url.endsWith('page=1') ? Array.from({ length: 100 }, (_, number) => ({ number })) : [{ number: 100 }] };
  });
  assert.equal(result.length, 101);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].auth, 'Bearer test-secret');
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
});
test('Upptime renders the stale notice and original branded navigation without a duplicate title', async () => {
  const require = createRequire(import.meta.url);
  const { compile } = require('svelte/compiler');
  const { writable } = require('svelte/store');
  const layoutConfig = { path: '/', i18n: { footer: 'Upptime', locale: 'en' }, 'status-website': {
    hideNavTitle: true, name: 'Agio Status', logoUrl: '/agio-logo-blue.png', themeUrl: '/agio-theme.css',
    navbar: [{ title: 'Status', href: '/' }, { title: 'Docs', href: 'https://docs.agiodigital.com/' },
      { title: 'Contact', href: 'mailto:devs@agiodigital.com' }],
  } };
  const sources = {};
  for (const path of ['routes/_layout.svelte', 'components/Nav.svelte']) sources[path] = await readFile(`${packageRoot}/src/${path}`, 'utf8');
  function component(path) {
    const module = { exports: {} };
    const code = compile(sources[path], { generate: 'ssr', format: 'cjs' }).js.code;
    runInNewContext(code, { module, exports: module.exports, require: name => {
      if (name.includes('config.json')) return { default: layoutConfig };
      if (name.includes('utils/snapshot')) return { data, fresh: writable(false), refreshFreshness() {} };
      if (name.includes('Nav.svelte')) return { default: component('components/Nav.svelte') };
      if (name === 'snarkdown') return { default: require(name) };
      return require(name);
    } });
    return module.exports.default;
  }
  const html = component('routes/_layout.svelte').render({}).html;
  assert.match(html, /Status updates delayed/);
  assert.match(html, /The latest checks are delayed/);
  assert.doesNotMatch(html, /Selected public routes|GitHub token|published status data/);
  assert.match(html, /agio-logo-blue.png/);
  assert.match(html, /mailto:devs@agiodigital.com/);
  assert.doesNotMatch(html, /<div>Agio Status<\/div>/);
});

test('legacy rate-limit link returns clients to service status', async () => {
  const source = await readFile(`${packageRoot}/src/routes/rate-limit-exceeded.svelte`, 'utf8');
  assert.match(source, /onMount\(\(\) => goto\(config.path \|\| "\/", \{ replaceState: true \}\)\)/);
  assert.doesNotMatch(source, /GitHub token|published status data|Status information/);
});
