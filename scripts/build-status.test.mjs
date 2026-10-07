import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchIncidents, fetchMonitorRun, readProbe, render } from './build-status.mjs';

const now = Date.parse('2026-10-07T04:00:00Z');
const snapshot = {
  repository: 'agio-digital/agio-status', generatedAt: new Date(now).toISOString(),
  sites: [{ name: 'API', slug: 'api', status: 'up', checkedAt: new Date(now).toISOString(), responseTime: 100, uptimeWeek: '100%' }], incidents: []
};

test('public HTML needs no GitHub API, token or visitor request', () => {
  const html = render(snapshot, now);
  assert.match(html, /All monitored services operational/);
  assert.doesNotMatch(html, /api\.github\.com|personal-access-token|fetch\(|Octokit|localStorage/);
});
test('stale probes are not presented as current operational status', () => {
  assert.match(render({ ...snapshot, sites: [{ ...snapshot.sites[0], checkedAt: new Date(now - 21 * 60000).toISOString() }] }, now), /Status updates delayed/);
  assert.match(render(snapshot, now + 21 * 60000), /Status updates delayed/);
  assert.match(render({ ...snapshot, monitorSucceeded: false }, now), /Status updates delayed/);
});
test('freshness uses completed monitoring runs, not history file change times', async () => {
  const run = await fetchMonitorRun('agio-digital/agio-status', 'test-only', async () => ({ ok: true, json: async () => ({ workflow_runs: [
    { path: '.github/workflows/publish-status.yml', head_branch: 'main', status: 'completed', updated_at: '2026-10-07T04:05:00Z', conclusion: 'success' },
    { path: '.github/workflows/uptime.yml', head_branch: 'main', status: 'completed', updated_at: '2026-10-07T04:00:00Z', conclusion: 'failure' }
  ] }) }));
  assert.deepEqual(run, { checkedAt: '2026-10-07T04:00:00Z', succeeded: false });
});
test('incident titles and bodies cannot inject HTML', () => {
  const html = render({ ...snapshot, incidents: [{ number: 1, title: '<script>bad</script>', body: '<img src=x onerror=bad>', state: 'open', url: 'https://github.com/agio-digital/agio-status/issues/1' }] }, now);
  assert.match(html, /&lt;script&gt;bad/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /Service disruption reported/);
});
test('missing or invalid probe timestamps fail publication', () => {
  assert.throws(() => readProbe('status: up\nlastUpdated: unknown'));
  assert.deepEqual(readProbe('status: down\nresponseTime: 0\nlastUpdated: 2026-10-07T04:00:00Z'), { status: 'down', responseTime: 0, checkedAt: '2026-10-07T04:00:00Z' });
});
test('API failures fail the build instead of publishing an empty incident list', async () => {
  await assert.rejects(fetchIncidents('agio-digital/agio-status', 'test-only', async () => ({ ok: false, status: 403 })), /HTTP 403/);
});
test('all open issue pages are read, PRs excluded and token stays in build headers', async () => {
  let calls = 0;
  const incident = { number: 101, title: 'API down', labels: [{ name: 'status' }], state: 'open', updated_at: '2026-10-07T04:00:00Z' };
  const result = await fetchIncidents('agio-digital/agio-status', 'test-only', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    calls++;
    return { ok: true, json: async () => url.includes('state=closed') ? [] : url.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => ({ number: i, pull_request: {} })) : [incident] };
  });
  assert.equal(calls, 3);
  assert.equal(result.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /test-only/);
});
