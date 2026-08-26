// Site contract tests: agent-readiness invariants (domain, twins, 404, llms.txt,
// sitemap, robots, JSON-LD/OG, middleware negotiation map). Run: bun tests/site.ts
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PUB = ROOT + 'public';
const DOMAIN = 'https://json.justgiulio.dev';
const PAGES = ['/', '/privacy', '/about', '/contact'];

let passed = 0;
function ok(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log('  ✓', name);
}
const read = (p: string): string => readFileSync(ROOT + p, 'utf8');

// ---------- domain consistency ----------
ok('no stale pastejson.com in shipped files', () => {
  const files = ['index.html', 'vercel.json', ...readdirSync(PUB).map((f) => `public/${f}`)];
  for (const f of files) {
    if (!/\.(html|md|txt|xml|json)$/.test(f)) continue;
    assert.ok(!read(f).includes('pastejson.com'), `${f} still references pastejson.com`);
  }
});

ok('every canonical/og:url points at json.justgiulio.dev', () => {
  for (const page of ['privacy', 'about', 'contact']) {
    const html = read(`public/${page}.html`);
    assert.ok(html.includes(`<link rel="canonical" href="${DOMAIN}/${page}" />`), page);
  }
  const idx = read('index.html');
  assert.ok(idx.includes(`<link rel="canonical" href="${DOMAIN}/" />`));
  assert.ok(idx.includes(`property="og:url" content="${DOMAIN}/"`));
});

// ---------- page × md twins ----------
ok('every page route has an html + markdown twin', () => {
  for (const p of PAGES) {
    const html = p === '/' ? 'index.html' : `public/${p}.html`;
    const md = p === '/' ? 'public/index.md' : `public/${p}.md`;
    assert.ok(existsSync(ROOT + html), `missing ${html}`);
    assert.ok(existsSync(ROOT + md), `missing ${md}`);
  }
});

ok('trust pages have ≥500 chars of content', () => {
  for (const p of ['privacy', 'about', 'contact']) {
    const html = read(`public/${p}.html`);
    const body = html.slice(html.indexOf('<body'));
    assert.ok(body.replace(/<[^>]+>/g, ' ').trim().length >= 500, `${p} too thin`);
  }
});

// ---------- 404 ----------
ok('404 page exists and gives agents recovery links', () => {
  const html = read('public/404.html');
  assert.ok(html.includes('404'));
  assert.ok(html.includes('/llms.txt'), 'must point agents at llms.txt');
  assert.ok(html.includes('/sitemap.xml'));
  for (const p of ['/', '/privacy', '/about', '/contact']) {
    assert.ok(html.includes(`href="${p}"`), `404 must link ${p}`);
  }
  assert.ok(html.includes('noindex'));
});

// ---------- llms.txt ----------
ok('llms.txt: format + when-to-use + agent notes + valid links', () => {
  const txt = read('public/llms.txt');
  assert.ok(txt.startsWith('# pastejson\n'));
  assert.ok(/^> /m.test(txt), 'must open with blockquote summary');
  assert.ok(txt.includes('## When to use this tool'));
  assert.ok(txt.includes('## Agent notes'));
  assert.ok(txt.includes('Accept: text/markdown'), 'must document negotiation');
  const urls = [...txt.matchAll(/https:\/\/[^\s)]]+/g)].map((m) => m[0]);
  for (const u of urls) assert.ok(u.startsWith(DOMAIN) || u === 'https://justgiulio.dev', u);
  for (const p of PAGES) {
    assert.ok(txt.includes(DOMAIN + (p === '/' ? '/' : p)), `llms.txt must list ${p}`);
  }
});

// ---------- sitemap + robots ----------
ok('sitemap.xml lists exactly the real pages', () => {
  const xml = read('public/sitemap.xml');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(
    locs,
    PAGES.map((p) => DOMAIN + p).sort(),
  );
});

ok('robots.txt: allow all + sitemap on final domain', () => {
  const txt = read('public/robots.txt');
  assert.ok(txt.includes('User-agent: *'));
  assert.ok(txt.includes('Allow: /'));
  assert.ok(txt.includes(`Sitemap: ${DOMAIN}/sitemap.xml`));
});

// ---------- structured data + OG ----------
ok('index.html JSON-LD parses with brand + alternateName', () => {
  const idx = read('index.html');
  const m = idx.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
  assert.ok(m, 'JSON-LD script present');
  const ld = JSON.parse(m![1]) as Record<string, unknown>;
  assert.strictEqual(ld['@type'], 'WebApplication');
  assert.strictEqual(ld.name, 'pastejson');
  assert.strictEqual(ld.alternateName, 'json');
  assert.strictEqual(ld.url, DOMAIN + '/');
  const author = ld.author as Record<string, unknown>;
  assert.strictEqual(author.url, 'https://justgiulio.dev');
});

ok('OG image wired: absolute URL + file shipped + large card', () => {
  const idx = read('index.html');
  assert.ok(idx.includes(`property="og:image" content="${DOMAIN}/og.png"`));
  assert.ok(idx.includes('twitter:card" content="summary_large_image'));
  assert.ok(existsSync(PUB + '/og.png'), 'public/og.png must exist');
});

// ---------- footer ----------
ok('footer links all trust pages + author site', () => {
  const foot = read('index.html').slice(read('index.html').indexOf('<footer'));
  for (const href of ['/privacy', '/about', '/contact', 'https://justgiulio.dev']) {
    assert.ok(foot.includes(`href="${href}"`), href);
  }
});

// ---------- markdown negotiation ----------
ok('middleware twins map covers exactly the page routes', async () => {
  const { MD_TWINS, config } = (await import('../middleware')) as {
    MD_TWINS: Record<string, string>;
    config: { matcher: string[] };
  };
  assert.deepStrictEqual(Object.keys(MD_TWINS).sort(), [...PAGES].sort());
  for (const md of Object.values(MD_TWINS)) {
    assert.ok(existsSync(PUB + '/' + md), `twin target missing: ${md}`);
  }
  for (const p of PAGES) assert.ok(config.matcher.includes(p), `matcher misses ${p}`);
});

ok('middleware negotiates md only on Accept: text/markdown', async () => {
  const mod = (await import('../middleware')) as {
    default: (req: Request) => Response | undefined;
  };
  const url = 'https://json.justgiulio.dev/privacy';
  const htmlReq = new Request(url, { headers: { accept: 'text/html' } });
  assert.strictEqual(mod.default(htmlReq), undefined, 'html request must pass through');
  const mdReq = new Request(url, { headers: { accept: 'text/markdown' } });
  const res = mod.default(mdReq);
  assert.ok(res, 'md request must rewrite');
  assert.ok((res!.headers.get('x-middleware-rewrite') ?? '').endsWith('.md'));
});

ok('vercel.json: cleanUrls + Vary:Accept + md Content-Type', () => {
  const cfg = JSON.parse(read('vercel.json')) as {
    cleanUrls: boolean;
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  assert.strictEqual(cfg.cleanUrls, true);
  const vary = cfg.headers.filter((h) => h.headers.some((x) => x.key === 'Vary'));
  const varySources = vary.map((h) => h.source);
  assert.ok(varySources.includes('/'), 'Vary on /');
  assert.ok(varySources.includes('/(privacy|about|contact)'), 'Vary on pages');
  const mdCt = cfg.headers.find(
    (h) => h.headers.some((x) => x.key === 'Content-Type') && h.source.includes('.md'),
  );
  assert.ok(mdCt, 'md Content-Type override');
});

console.log(`\n${passed} site contract tests passed`);
