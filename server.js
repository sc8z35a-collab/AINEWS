'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const FALLBACK_FILE = path.join(DATA_DIR, 'fallback.json');
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const HARD_STALE_MS = Number(process.env.HARD_STALE_MS || 24 * 60 * 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 8500);
const USER_AGENT = 'AI-Brief-Ultra/1.0 (+local news aggregator)';

const feeds = [
  { key: 'global', label: 'AI総合', locale: 'en-US', region: 'US', query: '"artificial intelligence" when:2d' },
  { key: 'jp', label: '日本AI', locale: 'ja', region: 'JP', query: 'AI OR 人工知能 when:2d' },
  { key: 'openai', label: 'OpenAI', locale: 'en-US', region: 'US', query: 'OpenAI when:7d' },
  { key: 'google', label: 'Google', locale: 'en-US', region: 'US', query: '"Google DeepMind" OR Gemini when:7d' },
  { key: 'anthropic', label: 'Anthropic', locale: 'en-US', region: 'US', query: 'Anthropic OR Claude when:7d' },
  { key: 'infra', label: 'AIインフラ', locale: 'en-US', region: 'US', query: 'NVIDIA AI OR "AI chip" OR "AI data center" when:7d' },
  { key: 'safety', label: 'AI安全性', locale: 'en-US', region: 'US', query: '"AI safety" OR "AI regulation" OR "AI security" when:7d' },
  { key: 'research', label: 'AI研究', locale: 'en-US', region: 'US', query: '"AI research" OR "machine learning" when:7d' }
];

let memoryCache = null;
let refreshPromise = null;
let lastForceRefreshAt = 0;

function rssUrl(feed) {
  const ceid = `${feed.region}:${feed.locale.startsWith('ja') ? 'ja' : 'en'}`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(feed.query)}&hl=${encodeURIComponent(feed.locale)}&gl=${encodeURIComponent(feed.region)}&ceid=${encodeURIComponent(ceid)}`;
}

function decodeXml(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtml(s = '') {
  return decodeXml(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? decodeXml(m[1].trim()) : '';
}

function pickSource(block) {
  const m = block.match(/<source(?:\s+url="([^"]*)")?[^>]*>([\s\S]*?)<\/source>/i);
  return m ? { url: decodeXml(m[1] || ''), name: stripHtml(m[2] || '') } : { url: '', name: '' };
}

function normalizeTitle(title = '') {
  return title
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[“”‘’'"`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(title = '') {
  const stop = new Set(['the','a','an','to','of','for','and','or','in','on','with','from','at','by','is','are','as','new','ai','人工知能']);
  return new Set(normalizeTitle(title).split(' ').filter(t => t.length > 2 && !stop.has(t)));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function stableId(seed) {
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

function classify(article) {
  const text = `${article.title} ${article.source}`.toLowerCase();
  const categories = new Set();
  const companies = new Set();

  const has = (...words) => words.some(w => text.includes(w));

  if (has('openai', 'chatgpt', 'gpt-')) companies.add('openai');
  if (has('google', 'deepmind', 'gemini', 'gemma')) companies.add('google');
  if (has('anthropic', 'claude')) companies.add('anthropic');
  if (has('nvidia', 'cuda', 'rubin', 'blackwell')) companies.add('nvidia');
  if (has('meta', 'llama')) companies.add('meta');
  if (has('microsoft', 'copilot', 'azure')) companies.add('microsoft');
  if (has('xai', 'grok')) companies.add('xai');
  if (has('amazon', 'aws')) companies.add('amazon');

  if (has('model', 'gpt', 'gemini', 'claude', 'llama', 'benchmark', 'reasoning', 'agent')) categories.add('models');
  if (has('chip', 'gpu', 'data center', 'datacenter', 'compute', 'nvidia', 'semiconductor', 'cloud')) categories.add('infrastructure');
  if (has('safety', 'security', 'cyber', 'jailbreak', 'risk', 'regulation', 'policy', 'law', 'copyright')) categories.add('safety');
  if (has('research', 'study', 'paper', 'science', 'scientist', 'benchmark', 'robotics')) categories.add('research');
  if (has('funding', 'acquire', 'acquisition', 'revenue', 'earnings', 'deal', 'partnership', 'startup', 'joins')) categories.add('business');
  if (!categories.size) categories.add('general');

  return { categories: [...categories], companies: [...companies] };
}

function parseRss(xml, feed) {
  const out = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  for (const block of items.slice(0, 45)) {
    let title = stripHtml(pickTag(block, 'title'));
    const link = stripHtml(pickTag(block, 'link'));
    const pubDateRaw = stripHtml(pickTag(block, 'pubDate'));
    const guid = stripHtml(pickTag(block, 'guid'));
    const source = pickSource(block);
    let description = stripHtml(pickTag(block, 'description'));

    if (!title || !link) continue;
    if (source.name && title.endsWith(` - ${source.name}`)) title = title.slice(0, -(` - ${source.name}`.length));

    const publishedAt = Number.isNaN(Date.parse(pubDateRaw)) ? new Date().toISOString() : new Date(pubDateRaw).toISOString();
    if (description.length > 560) description = description.slice(0, 557).trimEnd() + '…';
    if (description.toLowerCase() === title.toLowerCase()) description = '';

    const article = {
      id: stableId(guid || link || title),
      title,
      url: link,
      sourceUrl: source.url || '',
      source: source.name || 'Google News',
      publishedAt,
      summary: description,
      feedKeys: [feed.key],
      feedLabels: [feed.label],
      locale: feed.locale,
      origin: 'live'
    };
    Object.assign(article, classify(article));
    out.push(article);
  }
  return out;
}

async function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, 'accept': 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function mergeExact(items) {
  const map = new Map();
  for (const item of items) {
    const key = normalizeTitle(item.title);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { ...item, feedKeys: [...item.feedKeys], feedLabels: [...item.feedLabels] });
      continue;
    }
    const prev = map.get(key);
    prev.feedKeys = [...new Set([...prev.feedKeys, ...item.feedKeys])];
    prev.feedLabels = [...new Set([...prev.feedLabels, ...item.feedLabels])];
    if (new Date(item.publishedAt) > new Date(prev.publishedAt)) prev.publishedAt = item.publishedAt;
    if (!prev.summary && item.summary) prev.summary = item.summary;
  }
  return [...map.values()];
}

function buildClusters(articles) {
  const clusters = [];
  const sorted = [...articles].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  for (const article of sorted) {
    const tokens = tokenSet(article.title);
    let best = null;
    let bestScore = 0;
    for (const cluster of clusters.slice(0, 140)) {
      const score = jaccard(tokens, cluster.tokens);
      if (score > bestScore) { bestScore = score; best = cluster; }
    }
    if (best && bestScore >= 0.5) {
      best.items.push(article);
      best.sources.add(article.source);
      article.feedKeys.forEach(x => best.feedKeys.add(x));
      if (new Date(article.publishedAt) > new Date(best.representative.publishedAt)) best.representative = article;
      for (const t of tokens) best.tokens.add(t);
    } else {
      clusters.push({ representative: article, items: [article], tokens, sources: new Set([article.source]), feedKeys: new Set(article.feedKeys) });
    }
  }

  const now = Date.now();
  return clusters.map(cluster => {
    const ageH = Math.max(0, (now - new Date(cluster.representative.publishedAt).getTime()) / 36e5);
    const freshness = Math.max(0, 52 - Math.min(52, ageH * 1.6));
    const diversity = Math.min(34, cluster.sources.size * 11);
    const breadth = Math.min(18, cluster.feedKeys.size * 4.5);
    const volume = Math.min(20, Math.max(0, cluster.items.length - 1) * 6);
    const score = Math.round((freshness + diversity + breadth + volume) * 10) / 10;
    return {
      id: cluster.representative.id,
      title: cluster.representative.title,
      source: cluster.representative.source,
      publishedAt: cluster.representative.publishedAt,
      companies: cluster.representative.companies,
      categories: cluster.representative.categories,
      score,
      sourceCount: cluster.sources.size,
      mentionCount: cluster.items.length,
      queryCount: cluster.feedKeys.size,
      relatedIds: cluster.items.map(x => x.id)
    };
  }).sort((a, b) => b.score - a.score || new Date(b.publishedAt) - new Date(a.publishedAt));
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return null; }
}

async function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function loadFallback() {
  const raw = await readJson(FALLBACK_FILE);
  const articles = (raw?.articles || []).map(a => ({ ...a, origin: 'fallback', ...classify(a) }));
  return {
    generatedAt: raw?.generatedAt || new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    mode: 'fallback',
    degraded: true,
    sourceStats: [{ key: 'fallback', label: '内蔵フォールバック', ok: true, count: articles.length }],
    articles,
    trending: buildClusters(articles)
  };
}

async function loadDiskCache() {
  const cache = await readJson(CACHE_FILE);
  if (!cache?.articles?.length) return null;
  return cache;
}

async function refreshNews(force = false) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const startedAt = Date.now();
    const results = await Promise.allSettled(feeds.map(async feed => {
      const xml = await fetchText(rssUrl(feed));
      const parsed = parseRss(xml, feed);
      if (!parsed.length) throw new Error('0 items parsed');
      return { feed, parsed };
    }));

    const articles = [];
    const sourceStats = [];
    for (let i = 0; i < results.length; i++) {
      const feed = feeds[i];
      const r = results[i];
      if (r.status === 'fulfilled') {
        articles.push(...r.value.parsed);
        sourceStats.push({ key: feed.key, label: feed.label, ok: true, count: r.value.parsed.length });
      } else {
        sourceStats.push({ key: feed.key, label: feed.label, ok: false, count: 0, error: String(r.reason?.message || r.reason || 'fetch failed') });
      }
    }

    let merged = mergeExact(articles);
    merged.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    merged = merged.slice(0, 180);

    if (merged.length < 8) {
      const disk = await loadDiskCache();
      if (disk?.articles?.length) {
        disk.mode = 'stale-cache';
        disk.degraded = true;
        disk.fetchedAt = new Date().toISOString();
        disk.sourceStats = sourceStats;
        memoryCache = disk;
        return disk;
      }
      const fallback = await loadFallback();
      fallback.sourceStats = sourceStats.concat(fallback.sourceStats);
      memoryCache = fallback;
      return fallback;
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      mode: 'live',
      degraded: sourceStats.filter(x => !x.ok).length > 2,
      fetchDurationMs: Date.now() - startedAt,
      sourceStats,
      articles: merged,
      trending: buildClusters(merged)
    };
    memoryCache = payload;
    try { await writeJsonAtomic(CACHE_FILE, payload); } catch {}
    return payload;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function getNews({ force = false } = {}) {
  const now = Date.now();
  if (force && now - lastForceRefreshAt < 20_000) force = false;
  if (force) lastForceRefreshAt = now;

  if (memoryCache?.articles?.length) {
    const age = now - new Date(memoryCache.generatedAt || 0).getTime();
    if (!force && age < CACHE_TTL_MS) return memoryCache;
    if (!force && age < HARD_STALE_MS) {
      refreshNews(false).catch(() => {});
      return memoryCache;
    }
  }

  if (!memoryCache) memoryCache = await loadDiskCache();
  if (memoryCache?.articles?.length && !force) {
    const age = now - new Date(memoryCache.generatedAt || 0).getTime();
    if (age < CACHE_TTL_MS) return memoryCache;
  }

  return refreshNews(force);
}

function queryArticles(payload, params) {
  let rows = [...payload.articles];
  const company = (params.get('company') || '').toLowerCase();
  const category = (params.get('category') || '').toLowerCase();
  const q = (params.get('q') || '').trim().toLowerCase();
  const source = (params.get('source') || '').trim().toLowerCase();
  const limit = Math.min(100, Math.max(1, Number(params.get('limit') || 36)));
  const offset = Math.max(0, Number(params.get('offset') || 0));

  if (company) rows = rows.filter(a => a.companies.includes(company));
  if (category) rows = rows.filter(a => a.categories.includes(category));
  if (source) rows = rows.filter(a => a.source.toLowerCase().includes(source));
  if (q) rows = rows.filter(a => `${a.title} ${a.summary} ${a.source}`.toLowerCase().includes(q));

  return { total: rows.length, items: rows.slice(offset, offset + limit) };
}

function json(res, status, body, req) {
  const raw = Buffer.from(JSON.stringify(body));
  const canGzip = /gzip/.test(req.headers['accept-encoding'] || '') && raw.length > 1024;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  if (canGzip) {
    res.setHeader('content-encoding', 'gzip');
    return res.end(zlib.gzipSync(raw));
  }
  res.end(raw);
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(path.resolve(PUBLIC_DIR) + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) return false;
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return false;
    const buf = await fsp.readFile(file);
    res.statusCode = 200;
    res.setHeader('content-type', mime[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('cache-control', /\.(css|js|svg|png|webmanifest)$/.test(file) ? 'public, max-age=300' : 'no-cache');
    res.end(buf);
    return true;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/api/health') {
      const p = memoryCache || await loadDiskCache();
      return json(res, 200, { ok: true, service: 'ai-brief-ultra', now: new Date().toISOString(), cacheGeneratedAt: p?.generatedAt || null, mode: p?.mode || null }, req);
    }

    if (pathname === '/api/news') {
      const payload = await getNews({ force: url.searchParams.get('force') === '1' });
      const result = queryArticles(payload, url.searchParams);
      return json(res, 200, {
        meta: {
          generatedAt: payload.generatedAt, fetchedAt: payload.fetchedAt, mode: payload.mode,
          degraded: payload.degraded, sourceStats: payload.sourceStats, totalAvailable: payload.articles.length
        },
        ...result
      }, req);
    }

    if (pathname === '/api/trending') {
      const payload = await getNews({ force: url.searchParams.get('force') === '1' });
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit') || 15)));
      return json(res, 200, { meta: { generatedAt: payload.generatedAt, mode: payload.mode, degraded: payload.degraded }, items: payload.trending.slice(0, limit) }, req);
    }

    if (pathname === '/api/article') {
      const payload = await getNews();
      const id = url.searchParams.get('id') || '';
      const article = payload.articles.find(a => a.id === id);
      if (!article) return json(res, 404, { error: 'article_not_found' }, req);
      const cluster = payload.trending.find(t => t.relatedIds.includes(id));
      const related = payload.articles
        .filter(a => a.id !== id && (a.companies.some(c => article.companies.includes(c)) || a.categories.some(c => article.categories.includes(c))))
        .slice(0, 8);
      return json(res, 200, { article, cluster: cluster || null, related, meta: { generatedAt: payload.generatedAt, mode: payload.mode } }, req);
    }

    if (pathname === '/api/meta') {
      const payload = await getNews();
      const sourceMap = new Map();
      const companyMap = new Map();
      const catMap = new Map();
      for (const a of payload.articles) {
        sourceMap.set(a.source, (sourceMap.get(a.source) || 0) + 1);
        a.companies.forEach(x => companyMap.set(x, (companyMap.get(x) || 0) + 1));
        a.categories.forEach(x => catMap.set(x, (catMap.get(x) || 0) + 1));
      }
      return json(res, 200, {
        generatedAt: payload.generatedAt,
        mode: payload.mode,
        totals: { articles: payload.articles.length, sources: sourceMap.size },
        companies: Object.fromEntries([...companyMap].sort((a,b)=>b[1]-a[1])),
        categories: Object.fromEntries([...catMap].sort((a,b)=>b[1]-a[1])),
        sources: [...sourceMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([name,count])=>({name,count}))
      }, req);
    }

    if (await serveStatic(req, res, pathname)) return;
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('404 Not Found');
  } catch (err) {
    console.error(err);
    json(res, 500, { error: 'internal_error', message: process.env.NODE_ENV === 'development' ? String(err.stack || err) : 'Unexpected server error' }, req);
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`AI BRIEF Ultra running at http://${HOST}:${PORT}`);
  try {
    if (!memoryCache) memoryCache = await loadDiskCache();
    refreshNews(false).catch(() => {});
  } catch {}
});
