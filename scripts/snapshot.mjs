import { readFile } from 'node:fs/promises';
import { load } from 'js-yaml';
import markdown from 'snarkdown';
import sanitize from 'sanitize-html';

export async function github(path, token, request = fetch) {
  if (!token) throw new Error('Build-only GitHub token required');
  const response = await request(`https://api.github.com/repos/agio-digital/agio-status/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Snapshot ${path}: HTTP ${response.status}`);
  return response.json();
}

export async function pages(path, token, request = fetch) {
  const values = [];
  for (let page = 1; page <= 100; page++) {
    const items = await github(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, token, request);
    if (!Array.isArray(items)) throw new Error('Invalid paginated GitHub response');
    values.push(...items);
    if (items.length < 100) return values;
  }
  throw new Error('Snapshot pagination limit exceeded');
}

export function safeComment(comment) {
  const body = sanitize(markdown(String(comment.body || '')), {
    allowedTags: ['p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'a', 'hr'],
    allowedAttributes: { a: ['href', 'title'] },
    allowedSchemes: ['https', 'http', 'mailto'],
  });
  const url = value => /^https:\/\/github\.com\//.test(value || '') ? value : 'https://github.com/agio-digital/agio-status/issues';
  return { body, created_at: comment.created_at, html_url: url(comment.html_url), user: {
    login: String(comment.user?.login || 'Agio').replace(/[^\w-]/g, ''), html_url: url(comment.user?.html_url),
  } };
}

export async function snapshot(token, request = fetch, now = new Date()) {
  const sites = JSON.parse(await readFile('history/summary.json', 'utf8'));
  if (!Array.isArray(sites) || !sites.length) throw new Error('Empty service summary');
  for (const site of sites) {
    if (!/^[a-z0-9-]+$/.test(site.slug)) throw new Error('Invalid service slug');
    const probe = load(await readFile(`history/${site.slug}.yml`, 'utf8'));
    if (!['up', 'down', 'degraded'].includes(probe.status) || !Number.isFinite(Date.parse(probe.lastUpdated))) throw new Error('Invalid probe');
    site.status = probe.status;
    // Avoid a customer app dependency for the tiny service icon.
    site.icon = '/agio-favicon.svg';
  }
  const runs = await github('actions/runs?per_page=100', token, request);
  const monitor = runs.workflow_runs?.find(run => run.path === '.github/workflows/uptime.yml' && run.head_branch === 'main' && run.status === 'completed');
  if (!monitor || !Number.isFinite(Date.parse(monitor.updated_at))) throw new Error('No completed monitoring run');
  const issues = (await pages('issues?state=all&sort=created&direction=desc', token, request))
    .filter(issue => !issue.pull_request && issue.labels?.some(label => ['status', 'maintenance'].includes(label.name)))
    .map(issue => ({ number: issue.number, title: issue.title, state: issue.state, body: issue.body || '',
      created_at: issue.created_at, closed_at: issue.closed_at, comments: issue.comments,
      labels: issue.labels.map(label => ({ name: label.name })),
    }));
  const comments = {}, commits = {};
  for (const issue of issues) comments[issue.number] = issue.comments
    ? (await pages(`issues/${issue.number}/comments`, token, request)).map(safeComment) : [];
  for (const site of sites) {
    commits[site.slug] = (await github(`commits?path=history/${site.slug}.yml&per_page=28`, token, request))
      .map(item => ({ commit: { message: item.commit.message, committer: { date: item.commit.committer.date } } }));
  }
  return { generatedAt: now.toISOString(), checkedAt: monitor.updated_at,
    monitorSucceeded: monitor.conclusion === 'success', sites, issues, comments, commits };
}
