'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const gzipAsync = promisify(zlib.gzip);
const PORT = envNumber('PORT', 8787, 1, 65535);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const FALLBACK_FILE = path.join(DATA_DIR, 'fallback.json');
const CACHE_TTL_MS = envNumber('CACHE_TTL_MS', 10 * 60 * 1000, 5_000, 7 * 24 * 60 * 60 * 1000);
const HARD_STALE_MS = envNumber('HARD_STALE_MS', 24 * 60 * 60 * 1000, CACHE_TTL_MS, 30 * 24 * 60 * 60 * 1000);
const FETCH_TIMEOUT_MS = envNumber('FETCH_TIMEOUT_MS', 8500, 1000, 60_000);
const REFRESH_MIN_INTERVAL_MS = envNumber('REFRESH_MIN_INTERVAL_MS', 60_000, 10_000, 60 * 60 * 1000);
const FORCE_IP_INTERVAL_MS = envNumber('FORCE_IP_INTERVAL_MS', 5 * 60 * 1000, REFRESH_MIN_INTERVAL_MS, 24 * 60 * 60 * 1000);
const USER_AGENT = 'AI-Brief-Ultra/1.1 (+local news aggregator)';
const CACHE_SCHEMA = 2;

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
let lastRefreshAttemptAt = 0;
let nextRefreshAllowedAt = 0;
let consecutiveRefreshFailures = 0;
let lastForceRefreshAt = 0;
const forceByIp = new Map();

function envNumber(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function rssUrl(feed) {
  const ceid = `${feed.region}:${feed.locale.startsWith('ja') ? 'ja' : 'en'}`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(feed.query)}&hl=${encodeURIComponent(feed.locale)}&gl=${encodeURIComponent(feed.region)}&ceid=${encodeURIComponent(ceid)}`;
}

function decodeCodePoint(n) {
  const cp = Number(n);
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
  try { return String.fromCodePoint(cp); } catch { return '\uFFFD'; }
}

function decodeXml(s = '') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => decodeCodePoint(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => decodeCodePoint(parseInt(n, 16)));
}

function stripHtml(s = '') {
  return decodeXml(String(s))
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTagRaw(block, tag) {
  const safeTag = String(tag).replace(/[^A-Za-z0-9:_-]/g, '');
  const m = String(block).match(new RegExp(`<${safeTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeTag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function pickSource(block) {
  const m = String(block).match(/<source(?:\s+url="([^"]*)")?[^>]*>([\s\S]*?)<\/source>/i);
  return m ? { url: safeHttpUrl(decodeXml(m[1] || '')), name: stripHtml(m[2] || '') } : { url: '', name: '' };
}

function safeHttpUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch { return ''; }
}

function normalizeTitle(title = '') {
  return String(title)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[“”‘’'"`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(title = '') {
  const normalized = normalizeTitle(title);
  const tokens = new Set();
  const stop = new Set(['the','a','an','to','of','for','and','or','in','on','with','from','at','by','is','are','as','new','ai','人工知能']);
  const words = normalized.match(/[a-z]+|\d+(?:\.\d+)*|[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]+/gu) || [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^[a-z]+$/i.test(w)) {
      if (w.length >= 2 && !stop.has(w)) tokens.add(w);
      const next = words[i + 1];
      if (next && /^\d+(?:\.\d+)*$/.test(next) && /^(gpt|gemini|claude|llama|opus|sonnet|flash)$/i.test(w)) tokens.add(`${w}:${next}`);
    } else if (/^\d/.test(w)) {
      tokens.add(`#${w}`);
    } else {
      const chars = [...w];
      if (chars.length <= 2) tokens.add(w);
      for (let n = 2; n <= 3; n++) {
        for (let j = 0; j <= chars.length - n; j++) tokens.add(chars.slice(j, j + n).join(''));
      }
    }
  }
  return tokens;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function stableId(seed) {
  return crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 16);
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function hasCjk(s) { return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(s); }
function containsTerm(text, term) {
  const t = String(term).toLowerCase();
  if (hasCjk(t)) return text.includes(t);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(t)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}
function hasAny(text, terms) { return terms.some(t => containsTerm(text, t)); }

function classify(article) {
  const text = `${article?.title || ''} ${article?.source || ''}`.toLowerCase().normalize('NFKC');
  const categories = new Set();
  const companies = new Set();

  if (hasAny(text, ['openai','chatgpt','gpt','codex'])) companies.add('openai');
  if (hasAny(text, ['google','deepmind','gemini','gemma'])) companies.add('google');
  if (hasAny(text, ['anthropic','claude'])) companies.add('anthropic');
  if (hasAny(text, ['nvidia','cuda','rubin','blackwell'])) companies.add('nvidia');
  if (hasAny(text, ['meta','llama'])) companies.add('meta');
  if (hasAny(text, ['microsoft','copilot','azure'])) companies.add('microsoft');
  if (hasAny(text, ['xai','grok'])) companies.add('xai');
  if (hasAny(text, ['amazon','aws'])) companies.add('amazon');

  if (hasAny(text, ['model','models','gpt','gemini','claude','llama','benchmark','reasoning','agent','モデル','推論','エージェント','ベンチマーク'])) categories.add('models');
  if (hasAny(text, ['chip','chips','gpu','data center','datacenter','compute','nvidia','semiconductor','cloud','チップ','半導体','データセンター','計算資源','クラウド','gpu'])) categories.add('infrastructure');
  if (hasAny(text, ['safety','security','cyber','jailbreak','risk','regulation','policy','law','laws','copyright','安全','安全性','セキュリティ','サイバー','規制','政策','法律','著作権','リスク'])) categories.add('safety');
  if (hasAny(text, ['research','study','paper','science','scientist','benchmark','robotics','研究','論文','科学','科学者','ロボット','ロボティクス'])) categories.add('research');
  if (hasAny(text, ['funding','acquire','acquisition','revenue','earnings','deal','partnership','startup','joins','資金調達','買収','売上','決算','提携','スタートアップ','参画','就任'])) categories.add('business');
  if (!categories.size) categories.add('general');

  return { categories: [...categories], companies: [...companies] };
}

function normalizePublishedAt(raw, now = Date.now()) {
  const ms = Date.parse(String(raw || ''));
  if (!Number.isFinite(ms)) return null;
  if (ms > now + 15 * 60 * 1000) return new Date(now).toISOString();
  return new Date(ms).toISOString();
}

function articleTime(a) {
  const ms = Date.parse(a?.publishedAt || '');
  return Number.isFinite(ms) ? ms : 0;
}

function parseRss(xml, feed) {
  const out = [];
  const items = String(xml).match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of items.slice(0, 45)) {
    let title = stripHtml(pickTagRaw(block, 'title'));
    const link = safeHttpUrl(stripHtml(pickTagRaw(block, 'link')));
    const pubDateRaw = stripHtml(pickTagRaw(block, 'pubDate'));
    const guid = stripHtml(pickTagRaw(block, 'guid'));
    const source = pickSource(block);
    let description = stripHtml(pickTagRaw(block, 'description'));

    if (!title || !link) continue;
    if (source.name && title.endsWith(` - ${source.name}`)) title = title.slice(0, -(` - ${source.name}`.length));

    const publishedAt = normalizePublishedAt(pubDateRaw);
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
      origin: 'live',
      sourceNames: [source.name || 'Google News'],
      mentionCount: 1
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
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 5_000_000) throw new Error('RSS response too large');
    return text;
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
      map.set(key, {
        ...item,
        feedKeys: [...new Set(item.feedKeys || [])],
        feedLabels: [...new Set(item.feedLabels || [])],
        companies: [...new Set(item.companies || [])],
        categories: [...new Set(item.categories || [])],
        sourceNames: [...new Set(item.sourceNames || [item.source])],
        mentionCount: Math.max(1, Number(item.mentionCount) || 1)
      });
      continue;
    }

    const prev = map.get(key);
    prev.feedKeys = [...new Set([...prev.feedKeys, ...(item.feedKeys || [])])];
    prev.feedLabels = [...new Set([...prev.feedLabels, ...(item.feedLabels || [])])];
    prev.companies = [...new Set([...prev.companies, ...(item.companies || [])])];
    prev.categories = [...new Set([...prev.categories, ...(item.categories || [])])];
    prev.sourceNames = [...new Set([...prev.sourceNames, ...(item.sourceNames || [item.source])])];
    prev.mentionCount += Math.max(1, Number(item.mentionCount) || 1);

    if (articleTime(item) > articleTime(prev)) {
      const keepId = prev.id;
      const mergedFields = {
        title: item.title,
        url: item.url,
        sourceUrl: item.sourceUrl,
        source: item.source,
        publishedAt: item.publishedAt,
        summary: item.summary || prev.summary,
        locale: item.locale,
        origin: item.origin
      };
      Object.assign(prev, mergedFields);
      prev.id = keepId;
    } else if (!prev.summary && item.summary) {
      prev.summary = item.summary;
    }
  }
  return [...map.values()];
}

function buildClusters(articles) {
  const clusters = [];
  const sorted = [...articles].sort((a, b) => articleTime(b) - articleTime(a));

  for (const article of sorted) {
    const tokens = tokenSet(article.title);
    let best = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      const score = jaccard(tokens, cluster.tokens);
      if (score > bestScore) { bestScore = score; best = cluster; }
    }

    if (best && bestScore >= 0.48) {
      best.items.push(article);
      for (const s of article.sourceNames || [article.source]) best.sources.add(s);
      for (const x of article.feedKeys || []) best.feedKeys.add(x);
      best.mentions += Math.max(1, Number(article.mentionCount) || 1);
      if (articleTime(article) > articleTime(best.representative)) {
        best.representative = article;
        best.tokens = tokens;
      }
    } else {
      clusters.push({
        representative: article,
        items: [article],
        tokens,
        sources: new Set(article.sourceNames || [article.source]),
        feedKeys: new Set(article.feedKeys || []),
        mentions: Math.max(1, Number(article.mentionCount) || 1)
      });
    }
  }

  const now = Date.now();
  return clusters.map(cluster => {
    const publishedMs = articleTime(cluster.representative);
    const ageH = publishedMs ? Math.max(0, (now - Math.min(now, publishedMs)) / 36e5) : 72;
    const freshness = Math.max(0, 52 - Math.min(52, ageH * 1.6));
    const diversity = Math.min(34, cluster.sources.size * 11);
    const breadth = Math.min(18, cluster.feedKeys.size * 4.5);
    const volume = Math.min(20, Math.max(0, cluster.mentions - 1) * 6);
    const score = Math.round((freshness + diversity + breadth + volume) * 10) / 10;
    const companies = [...new Set(cluster.items.flatMap(x => x.companies || []))];
    const categories = [...new Set(cluster.items.flatMap(x => x.categories || []))];
    return {
      id: cluster.representative.id,
      title: cluster.representative.title,
      source: cluster.representative.source,
      publishedAt: cluster.representative.publishedAt,
      companies,
      categories,
      score,
      sourceCount: cluster.sources.size,
      mentionCount: cluster.mentions,
      queryCount: cluster.feedKeys.size,
      relatedIds: [...new Set(cluster.items.map(x => x.id))]
    };
  }).sort((a, b) => b.score - a.score || articleTime(b) - articleTime(a));
}

function normalizeArticle(a, origin = 'cache') {
  if (!a || typeof a !== 'object') return null;
  const title = String(a.title || '').trim();
  const url = safeHttpUrl(a.url);
  if (!title || !url) return null;
  const source = String(a.source || 'Unknown').trim().slice(0, 200) || 'Unknown';
  const article = {
    id: /^[a-zA-Z0-9_-]{4,80}$/.test(String(a.id || '')) ? String(a.id) : stableId(a.guid || url || title),
    title: title.slice(0, 600),
    url,
    sourceUrl: safeHttpUrl(a.sourceUrl),
    source,
    publishedAt: normalizePublishedAt(a.publishedAt),
    summary: String(a.summary || '').replace(/\s+/g, ' ').trim().slice(0, 560),
    feedKeys: Array.isArray(a.feedKeys) ? a.feedKeys.filter(x => typeof x === 'string').slice(0, 20) : [],
    feedLabels: Array.isArray(a.feedLabels) ? a.feedLabels.filter(x => typeof x === 'string').slice(0, 20) : [],
    locale: String(a.locale || ''),
    origin: a.origin === 'live' || a.origin === 'fallback' ? a.origin : origin,
    sourceNames: Array.isArray(a.sourceNames) ? a.sourceNames.filter(x => typeof x === 'string').slice(0, 30) : [source],
    mentionCount: Math.max(1, Number(a.mentionCount) || 1)
  };
  Object.assign(article, classify(article));
  return article;
}

function normalizePayload(raw, modeHint = 'cache') {
  if (!raw || !Array.isArray(raw.articles)) return null;
  const articles = raw.articles.map(a => normalizeArticle(a, modeHint)).filter(Boolean).slice(0, 180);
  if (!articles.length) return null;
  return {
    schema: CACHE_SCHEMA,
    generatedAt: normalizePublishedAt(raw.generatedAt) || new Date().toISOString(),
    fetchedAt: normalizePublishedAt(raw.fetchedAt) || new Date().toISOString(),
    mode: ['live','stale-cache','fallback'].includes(raw.mode) ? raw.mode : modeHint,
    degraded: Boolean(raw.degraded),
    fetchDurationMs: Number.isFinite(Number(raw.fetchDurationMs)) ? Number(raw.fetchDurationMs) : null,
    sourceStats: Array.isArray(raw.sourceStats) ? raw.sourceStats.slice(0, 30) : [],
    articles,
    trending: buildClusters(articles)
  };
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return null; }
}

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  } finally {
    fsp.unlink(tmp).catch(() => {});
  }
}

async function loadFallback() {
  const raw = await readJson(FALLBACK_FILE);
  const base = normalizePayload({ ...raw, mode: 'fallback', degraded: true }, 'fallback');
  if (!base) return { schema: CACHE_SCHEMA, generatedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), mode: 'fallback', degraded: true, sourceStats: [], articles: [], trending: [] };
  base.contentGeneratedAt = raw?.generatedAt || null;
  base.generatedAt = new Date().toISOString();
  base.fetchedAt = base.generatedAt;
  base.mode = 'fallback';
  base.degraded = true;
  base.sourceStats = [{ key: 'fallback', label: '内蔵フォールバック', ok: true, count: base.articles.length }];
  return base;
}

async function loadDiskCache() {
  return normalizePayload(await readJson(CACHE_FILE), 'stale-cache');
}

function registerRefreshFailure() {
  consecutiveRefreshFailures += 1;
  const backoff = Math.min(15 * 60 * 1000, 15_000 * (2 ** Math.min(6, consecutiveRefreshFailures - 1)));
  nextRefreshAllowedAt = Date.now() + backoff;
}

function registerRefreshSuccess() {
  consecutiveRefreshFailures = 0;
  nextRefreshAllowedAt = Date.now() + REFRESH_MIN_INTERVAL_MS;
}

async function refreshNews({ force = false } = {}) {
  if (refreshPromise) return refreshPromise;
  if (!force && Date.now() < nextRefreshAllowedAt) return memoryCache || await loadDiskCache() || await loadFallback();

  refreshPromise = (async () => {
    const startedAt = Date.now();
    lastRefreshAttemptAt = startedAt;
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
        sourceStats.push({ key: feed.key, label: feed.label, ok: false, count: 0, error: String(r.reason?.message || r.reason || 'fetch failed').slice(0, 200) });
      }
    }

    let merged = mergeExact(articles).sort((a, b) => articleTime(b) - articleTime(a)).slice(0, 180);
    if (merged.length < 8) {
      registerRefreshFailure();
      const disk = await loadDiskCache();
      if (disk?.articles?.length) {
        const stale = { ...disk, mode: 'stale-cache', degraded: true, fetchedAt: new Date().toISOString(), sourceStats, trending: buildClusters(disk.articles) };
        memoryCache = stale;
        return stale;
      }
      const fallback = await loadFallback();
      fallback.sourceStats = [...sourceStats, ...fallback.sourceStats];
      memoryCache = fallback;
      return fallback;
    }

    const payload = {
      schema: CACHE_SCHEMA,
      generatedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      mode: 'live',
      degraded: sourceStats.some(x => !x.ok),
      fetchDurationMs: Date.now() - startedAt,
      sourceStats,
      articles: merged,
      trending: buildClusters(merged)
    };
    memoryCache = payload;
    registerRefreshSuccess();
    try { await writeJsonAtomic(CACHE_FILE, payload); } catch (err) { console.error('cache write failed:', err.message); }
    return payload;
  })().finally(() => { refreshPromise = null; });

  return refreshPromise;
}

function staleView(payload, age) {
  if (!payload) return payload;
  if (payload.mode === 'fallback') return { ...payload, degraded: true, staleAgeMs: age };
  return { ...payload, mode: age >= CACHE_TTL_MS ? 'stale-cache' : payload.mode, degraded: payload.degraded || age >= CACHE_TTL_MS, staleAgeMs: age };
}

async function getNews({ force = false } = {}) {
  const now = Date.now();
  if (!memoryCache) memoryCache = await loadDiskCache();

  if (force) return refreshNews({ force: true });

  if (memoryCache?.articles?.length) {
    const age = Math.max(0, now - (Date.parse(memoryCache.generatedAt || '') || 0));
    if (age < CACHE_TTL_MS) return memoryCache;
    if (now >= nextRefreshAllowedAt) refreshNews().catch(err => { registerRefreshFailure(); console.error('background refresh failed:', err.message); });
    return staleView(memoryCache, age);
  }

  try {
    return await refreshNews();
  } catch (err) {
    registerRefreshFailure();
    console.error('initial refresh failed:', err.message);
    const fallback = await loadFallback();
    memoryCache = fallback;
    return fallback;
  }
}

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function parseBoundedInt(value, fallback, min, max, name = 'value') {
  if (value === null || value === undefined || value === '') return fallback;
  if (!/^-?\d+$/.test(String(value))) throw new HttpError(400, `invalid_${name}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, `invalid_${name}`);
  return n;
}

function queryArticles(payload, params) {
  let rows = [...payload.articles];
  const company = (params.get('company') || '').trim().toLowerCase();
  const category = (params.get('category') || '').trim().toLowerCase();
  const q = (params.get('q') || '').trim().toLowerCase().slice(0, 200);
  const source = (params.get('source') || '').trim().toLowerCase().slice(0, 200);
  const limit = parseBoundedInt(params.get('limit'), 36, 1, 180, 'limit');
  const offset = parseBoundedInt(params.get('offset'), 0, 0, 10_000, 'offset');

  if (company) rows = rows.filter(a => (a.companies || []).includes(company));
  if (category) rows = rows.filter(a => (a.categories || []).includes(category));
  if (source) rows = rows.filter(a => String(a.source || '').toLowerCase().includes(source));
  if (q) rows = rows.filter(a => `${a.title || ''} ${a.summary || ''} ${a.source || ''}`.toLowerCase().includes(q));

  return { total: rows.length, items: rows.slice(offset, offset + limit) };
}

function relatedArticles(payload, article, limit = 8) {
  const at = tokenSet(article.title);
  return payload.articles
    .filter(a => a.id !== article.id)
    .map(a => {
      const sharedCompanies = (a.companies || []).filter(c => (article.companies || []).includes(c)).length;
      const sharedCategories = (a.categories || []).filter(c => c !== 'general' && (article.categories || []).includes(c)).length;
      const titleScore = jaccard(at, tokenSet(a.title));
      const score = sharedCompanies * 5 + sharedCategories * 2 + titleScore * 4;
      return { a, score };
    })
    .filter(x => x.score >= 1.25)
    .sort((x, y) => y.score - x.score || articleTime(y.a) - articleTime(x.a))
    .slice(0, limit)
    .map(x => x.a);
}

function acceptsGzip(header = '') {
  return String(header).split(',').some(part => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (name !== 'gzip' && name !== '*') return false;
    const q = params.map(x => x.trim()).find(x => x.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  });
}

async function json(res, status, body, req) {
  const raw = Buffer.from(JSON.stringify(body));
  const canGzip = acceptsGzip(req.headers['accept-encoding']) && raw.length > 1024;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('vary', 'Accept-Encoding');
  if (req.method === 'HEAD') return res.end();
  if (canGzip) {
    try {
      const gz = await gzipAsync(raw, { level: zlib.constants.Z_BEST_SPEED });
      res.setHeader('content-encoding', 'gzip');
      return res.end(gz);
    } catch {}
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
  const root = path.resolve(PUBLIC_DIR);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) return false;
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return false;
    const buf = req.method === 'HEAD' ? null : await fsp.readFile(file);
    res.statusCode = 200;
    res.setHeader('content-type', mime[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('cache-control', /\.(css|js|svg|png|webmanifest)$/.test(file) ? 'public, max-age=300' : 'no-cache');
    res.setHeader('content-length', req.method === 'HEAD' ? st.size : buf.length);
    res.end(buf || undefined);
    return true;
  } catch { return false; }
}

function clientIp(req) {
  return String(req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function allowForceRefresh(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const previous = forceByIp.get(ip) || 0;
  if (now - lastForceRefreshAt < REFRESH_MIN_INTERVAL_MS) return { allowed: false, reason: 'global_cooldown' };
  if (now - previous < FORCE_IP_INTERVAL_MS) return { allowed: false, reason: 'client_cooldown' };
  lastForceRefreshAt = now;
  forceByIp.set(ip, now);
  if (forceByIp.size > 1000) {
    for (const [key, ts] of forceByIp) if (now - ts > FORCE_IP_INTERVAL_MS * 2) forceByIp.delete(key);
  }
  return { allowed: true, reason: 'allowed' };
}

function metaFrom(payload, extra = {}) {
  return {
    generatedAt: payload.generatedAt,
    fetchedAt: payload.fetchedAt,
    mode: payload.mode,
    degraded: payload.degraded,
    staleAgeMs: payload.staleAgeMs || 0,
    sourceStats: payload.sourceStats,
    totalAvailable: payload.articles.length,
    ...extra
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('allow', 'GET, HEAD');
      return json(res, 405, { error: 'method_not_allowed' }, req);
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/api/health') {
      const p = memoryCache || await loadDiskCache();
      const ready = Boolean(p?.articles?.length);
      return json(res, ready ? 200 : 503, {
        ok: ready,
        ready,
        degraded: Boolean(p?.degraded || p?.mode !== 'live'),
        service: 'ai-brief-ultra',
        now: new Date().toISOString(),
        cacheGeneratedAt: p?.generatedAt || null,
        mode: p?.mode || null,
        lastRefreshAttemptAt: lastRefreshAttemptAt ? new Date(lastRefreshAttemptAt).toISOString() : null,
        nextRefreshAllowedAt: nextRefreshAllowedAt ? new Date(nextRefreshAllowedAt).toISOString() : null
      }, req);
    }

    if (pathname === '/api/news') {
      const forceRequested = url.searchParams.get('force') === '1';
      const permit = forceRequested ? allowForceRefresh(req) : { allowed: false, reason: 'not_requested' };
      const payload = await getNews({ force: forceRequested && permit.allowed });
      const result = queryArticles(payload, url.searchParams);
      const refreshStatus = !forceRequested ? 'none' : !permit.allowed ? 'throttled' : payload.mode === 'live' ? 'updated' : 'degraded';
      return json(res, 200, { meta: metaFrom(payload, { refreshStatus, refreshReason: permit.reason }), ...result }, req);
    }

    if (pathname === '/api/trending') {
      const payload = await getNews();
      const limit = parseBoundedInt(url.searchParams.get('limit'), 15, 1, 50, 'limit');
      return json(res, 200, { meta: metaFrom(payload), items: payload.trending.slice(0, limit) }, req);
    }

    if (pathname === '/api/article') {
      const payload = await getNews();
      const id = url.searchParams.get('id') || '';
      if (!/^[a-zA-Z0-9_-]{4,80}$/.test(id)) throw new HttpError(400, 'invalid_article_id');
      const article = payload.articles.find(a => a.id === id);
      if (!article) return json(res, 404, { error: 'article_not_found' }, req);
      const cluster = payload.trending.find(t => (t.relatedIds || []).includes(id));
      const related = relatedArticles(payload, article, 8);
      return json(res, 200, { article, cluster: cluster || null, related, meta: metaFrom(payload) }, req);
    }

    if (pathname === '/api/meta') {
      const payload = await getNews();
      const sourceMap = new Map();
      const companyMap = new Map();
      const catMap = new Map();
      for (const a of payload.articles) {
        sourceMap.set(a.source, (sourceMap.get(a.source) || 0) + 1);
        (a.companies || []).forEach(x => companyMap.set(x, (companyMap.get(x) || 0) + 1));
        (a.categories || []).forEach(x => catMap.set(x, (catMap.get(x) || 0) + 1));
      }
      return json(res, 200, {
        generatedAt: payload.generatedAt,
        mode: payload.mode,
        degraded: payload.degraded,
        totals: { articles: payload.articles.length, sources: sourceMap.size },
        companies: Object.fromEntries([...companyMap].sort((a,b)=>b[1]-a[1])),
        categories: Object.fromEntries([...catMap].sort((a,b)=>b[1]-a[1])),
        sources: [...sourceMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([name,count])=>({name,count}))
      }, req);
    }

    if (await serveStatic(req, res, pathname)) return;
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(req.method === 'HEAD' ? undefined : '404 Not Found');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    return json(res, status, { error: err instanceof HttpError ? err.code : 'internal_error', message: process.env.NODE_ENV === 'development' ? String(err.stack || err) : undefined }, req);
  }
});

async function startServer() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, async () => {
      server.removeListener('error', reject);
      console.log(`AI BRIEF Ultra running at http://${HOST}:${PORT}`);
      try {
        if (!memoryCache) memoryCache = await loadDiskCache();
        if (Date.now() >= nextRefreshAllowedAt) refreshNews().catch(err => console.error('startup refresh failed:', err.message));
      } catch (err) { console.error('startup initialization failed:', err.message); }
      resolve(server);
    });
  });
}

if (require.main === module) startServer().catch(err => { console.error(err); process.exitCode = 1; });

module.exports = {
  server,
  startServer,
  decodeXml,
  stripHtml,
  safeHttpUrl,
  normalizeTitle,
  tokenSet,
  jaccard,
  classify,
  normalizePublishedAt,
  parseRss,
  mergeExact,
  buildClusters,
  normalizePayload,
  parseBoundedInt,
  relatedArticles,
  acceptsGzip
};
