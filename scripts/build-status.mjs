import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const staleAfter = 20 * 60 * 1000;

export async function fetchIncidents(repository, token, request = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error('Repository and build-only GitHub token required');
  const incidents = [];
  for (let page = 1; page <= 20; page++) {
    const response = await request(`https://api.github.com/repos/${repository}/issues?state=open&per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Incident snapshot failed: HTTP ${response.status}`);
    const issues = await response.json();
    if (!Array.isArray(issues)) throw new Error('Invalid incident response');
    incidents.push(...issues.filter(issue => !issue.pull_request));
    if (issues.length < 100) break;
    if (page === 20) throw new Error('Open issue pagination limit exceeded');
  }
  const response = await request(`https://api.github.com/repos/${repository}/issues?state=closed&labels=status&sort=updated&direction=desc&per_page=30`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Incident history snapshot failed: HTTP ${response.status}`);
  const closed = await response.json();
  if (!Array.isArray(closed)) throw new Error('Invalid incident history response');
  const selected = [...incidents, ...closed.filter(issue => !issue.pull_request)].filter(issue =>
    issue.labels?.some(label => ['status', 'scheduled maintenance', 'maintenance'].includes(typeof label === 'string' ? label : label.name))
  );
  for (const issue of selected.filter(issue => issue.state === 'open' && issue.comments > 0)) {
    const page = Math.ceil(issue.comments / 100);
    const commentsResponse = await request(`https://api.github.com/repos/${repository}/issues/${issue.number}/comments?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30000)
    });
    if (!commentsResponse.ok) throw new Error(`Incident update snapshot failed: HTTP ${commentsResponse.status}`);
    const comments = await commentsResponse.json();
    if (!Array.isArray(comments)) throw new Error('Invalid incident updates response');
    issue.updates = comments.slice(-5).map(comment => ({ body: String(comment.body ?? '').slice(0, 4000), updatedAt: comment.updated_at }));
  }
  return selected.map(issue => ({
    number: issue.number, title: issue.title, state: issue.state, updatedAt: issue.updated_at,
    body: String(issue.body ?? '').slice(0, 4000), updates: issue.updates ?? [],
    url: `https://github.com/${repository}/issues/${issue.number}`
  }));
}

export function readProbe(yaml) {
  const field = key => yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  const status = field('status');
  const checkedAt = field('lastUpdated');
  if (!['up', 'down', 'degraded'].includes(status) || !Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid probe history');
  return { status, checkedAt, responseTime: Number(field('responseTime')) };
}

export function render(snapshot, now = Date.now()) {
  const oldestCheck = Math.min(...snapshot.sites.map(site => Date.parse(site.checkedAt)));
  const staleAt = Math.min(oldestCheck, Date.parse(snapshot.generatedAt)) + staleAfter;
  const stale = now >= staleAt;
  const active = snapshot.incidents.filter(issue => issue.state === 'open');
  const affected = snapshot.sites.some(site => site.status !== 'up');
  const headline = stale ? 'Status updates delayed' : affected || active.length ? 'Service disruption reported' : 'All monitored services operational';
  const incidentCards = issues => issues.map(issue => `<article class="incident"><h3><a href="${escape(issue.url)}">${escape(issue.title)}</a></h3><p class="muted">${issue.state === 'closed' ? 'Resolved' : 'Open'} · Updated ${escape(issue.updatedAt)}</p><p class="incident-body">${escape(issue.body)}</p>${(issue.updates ?? []).map(update => `<p class="muted">Update ${escape(update.updatedAt)}</p><p class="incident-body">${escape(update.body)}</p>`).join('')}</article>`).join('');
  const sites = snapshot.sites.map(site => `<article class="service" id="${escape(site.slug)}"><div class="service-heading"><h2><a href="/history/${escape(site.slug)}/">${escape(site.name)}</a></h2><span class="badge ${escape(site.status)}">${stale ? 'Last recorded: ' : ''}${escape(site.status === 'up' ? 'Operational' : site.status === 'down' ? 'Outage' : 'Degraded')}</span></div><p class="muted">Last checked <time datetime="${escape(site.checkedAt)}">${escape(site.checkedAt)}</time></p><div class="metrics"><span><strong>${escape(site.uptimeWeek)}</strong> uptime over 7 days</span><span><strong>${escape(site.responseTime)} ms</strong> latest response</span></div></article>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#193f66"><title>Agio Status</title><link rel="icon" href="/agio-favicon.svg"><style>
@font-face{font-family:Montserrat;src:url('/Montserrat-VariableFont_wght.ttf') format('truetype');font-weight:100 900;font-display:swap}*{box-sizing:border-box}body{margin:0;color:#193f66;background:#f4f8fb;font-family:Montserrat,system-ui,sans-serif;font-size:15px;line-height:1.6}a{color:inherit;text-underline-offset:4px}a:focus-visible{outline:3px solid #36b5d5;outline-offset:4px}nav{background:white;border-bottom:1px solid #dce6ef}.container{max-width:1040px;margin:auto;padding:0 24px}nav .container{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:88px}.logo img{display:block;width:138px;height:auto}.links{display:flex;flex-wrap:wrap;gap:24px}.links a{text-decoration:none;font-weight:550}main{padding-top:32px!important;padding-bottom:32px!important}h1{font-size:24px;margin:0 0 8px;font-weight:650;letter-spacing:-.025em}h2{font-size:18px;margin:0}h3{font-size:17px;margin:0 0 8px}.banner,.service,.incident,.help{background:white;border:1px solid #dce6ef;border-radius:16px;padding:24px;margin-bottom:16px}.banner{border-left:5px solid ${stale ? '#9a6700' : affected || active.length ? '#b42318' : '#13795b'}}.banner[data-stale=true]{border-left-color:#9a6700}.muted{color:#54687a;font-size:13px;margin:8px 0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:24px}.service{margin:0}.service-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.service-heading h2 a{text-decoration:none}.badge{border-radius:99px;padding:4px 10px;font-size:12px;white-space:nowrap;font-weight:600}.up{background:#e6f4ed;color:#13795b}.down{background:#feeceb;color:#b42318}.degraded{background:#fff3d6;color:#9a6700}[data-stale=true]~.grid .badge{background:#fff3d6;color:#9a6700}.metrics{display:flex;flex-direction:column;gap:6px;margin-top:20px;color:#54687a;font-size:13px}.metrics strong{color:#193f66}section>h2{margin:32px 0 16px}.incident-body{white-space:pre-wrap;overflow-wrap:anywhere}.help{margin-top:32px}.help p{margin:8px 0}.history-graph{width:100%;height:auto;display:block;margin-top:16px}footer{padding:24px 0;border-top:1px solid #dce6ef;font-size:12px;color:#54687a}@media(max-width:650px){nav .container{flex-direction:column;align-items:flex-start;padding-top:20px;padding-bottom:20px;gap:16px}.links{gap:20px}.grid{grid-template-columns:1fr}.container{padding:0 18px}h1{font-size:21px}.banner,.service,.incident,.help{padding:20px}}
</style></head><body><nav aria-label="Main navigation"><div class="container"><a class="logo" href="/" aria-label="Agio status home"><img src="/agio-logo-blue.png" alt="Agio"></a><div class="links"><a href="/">Status</a><a href="/#incidents">Incidents</a><a href="https://docs.agiodigital.com/">Docs</a><a href="mailto:devs@agiodigital.com">Contact</a></div></div></nav><main class="container"><section class="banner" id="availability" data-stale="${stale}" data-stale-at="${staleAt}" aria-live="polite"><h1 id="overall-status">${headline}</h1><p id="freshness" class="muted">${stale ? 'Checks or publication are delayed. Current availability is unknown; the last recorded results follow.' : 'Last recorded checks are shown below. Selected public routes are monitored; individual operations may still fail.'}</p><p class="muted">Snapshot published <time datetime="${escape(snapshot.generatedAt)}">${escape(snapshot.generatedAt)}</time> · Times shown in UTC</p></section><div class="grid">${sites}</div><section id="incidents"><h2>Incidents</h2>${active.length ? incidentCards(active) : '<p>No open incidents in this snapshot.</p>'}${snapshot.incidents.some(issue => issue.state === 'closed') ? '<h2>Recent incident history</h2>' + incidentCards(snapshot.incidents.filter(issue => issue.state === 'closed').slice(0, 10)) : ''}</section><section class="help"><h2>Need help?</h2><p><a href="mailto:devs@agiodigital.com">Email devs@agiodigital.com</a> with the app or API, production or sandbox, time and request ID. Please redact credentials and customer data.</p></section></main><footer><div class="container">Independent checks powered by Upptime · <a href="https://github.com/${escape(snapshot.repository)}">Source</a> · <a href="/status.json">Status snapshot</a></div></footer><script>
function checkFreshness(){const banner=document.getElementById('availability');if(Date.now()>=Number(banner.dataset.staleAt)){banner.dataset.stale='true';document.getElementById('overall-status').textContent='Status updates delayed';document.getElementById('freshness').textContent='Checks or publication are delayed. Current availability is unknown; the last recorded results follow.';document.querySelectorAll('.badge').forEach(el=>el.textContent='Last recorded: '+el.textContent.replace(/^Last recorded: /,''));}}checkFreshness();setInterval(checkFreshness,30000);
</script></body></html>`;
}

async function build() {
  const repository = process.env.GITHUB_REPOSITORY;
  const summary = JSON.parse(await readFile('history/summary.json', 'utf8'));
  if (!Array.isArray(summary) || !summary.length) throw new Error('Empty service summary');
  const sites = await Promise.all(summary.map(async site => {
    if (!/^[a-z0-9-]+$/.test(site.slug)) throw new Error('Invalid service slug');
    const probe = readProbe(await readFile(`history/${site.slug}.yml`, 'utf8'));
    return { name: site.name, slug: site.slug, uptimeWeek: site.uptimeWeek, ...probe };
  }));
  const incidents = await fetchIncidents(repository, process.env.GH_TOKEN);
  const snapshot = { repository, generatedAt: new Date().toISOString(), sites, incidents };
  await mkdir('dist', { recursive: true });
  await cp('assets', 'dist', { recursive: true });
  await cp('graphs', 'dist/graphs', { recursive: true });
  await writeFile('dist/status.json', JSON.stringify(snapshot));
  await writeFile('dist/index.html', render(snapshot));
  await writeFile('dist/CNAME', 'status.agiodigital.com\n');
  await writeFile('dist/.nojekyll', '');
  for (const site of sites) {
    await mkdir(`dist/history/${site.slug}`, { recursive: true });
    const graph = `<section class="help"><h2>${escape(site.name)} response times</h2><p class="muted">Graphs are generated separately and may lag behind the latest check.</p><img class="history-graph" src="/graphs/${escape(site.slug)}/response-time-week.png" alt="Response times over seven days"></section>`;
    await writeFile(`dist/history/${site.slug}/index.html`, render({ ...snapshot, sites: [site] }).replace('<section id="incidents">', `${graph}<section id="incidents">`));
  }
  await writeFile('dist/404.html', render(snapshot));
  await writeFile('dist/rate-limit-exceeded.html', render(snapshot));
  await mkdir('dist/rate-limit-exceeded', { recursive: true });
  await writeFile('dist/rate-limit-exceeded/index.html', render(snapshot));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await build();
