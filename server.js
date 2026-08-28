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
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const FALLBACK_FILE = path.resolve(process.env.FALLBACK_FILE || path.join(DATA_DIR, 'fallback.json'));
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime-state.json');
const REFRESH_LOCK_FILE = path.join(DATA_DIR, 'refresh.lock');
const RATE_LOCK_FILE = path.join(DATA_DIR, 'rate.lock');
const CACHE_TTL_MS = envNumber('CACHE_TTL_MS', 10 * 60 * 1000, 5_000, 7 * 24 * 60 * 60 * 1000);
const HARD_STALE_MS = envNumber('HARD_STALE_MS', 24 * 60 * 60 * 1000, CACHE_TTL_MS, 30 * 24 * 60 * 60 * 1000);
const FETCH_TIMEOUT_MS = envNumber('FETCH_TIMEOUT_MS', 8500, 1000, 60_000);
const REFRESH_MIN_INTERVAL_MS = envNumber('REFRESH_MIN_INTERVAL_MS', 60_000, 10_000, 60 * 60 * 1000);
const FORCE_IP_INTERVAL_MS = envNumber('FORCE_IP_INTERVAL_MS', 5 * 60 * 1000, REFRESH_MIN_INTERVAL_MS, 24 * 60 * 60 * 1000);
const USER_AGENT = 'AI-Brief-Ultra/1.2 (+local news aggregator)';
const CACHE_SCHEMA = 3;
const MAX_RSS_BYTES = 5_000_000;
const MAX_ARTICLES = 180;
const CLUSTER_WINDOW_MS = 48 * 60 * 60 * 1000;
const EXACT_WINDOW_MS = 48 * 60 * 60 * 1000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ENFORCE_HTTPS = process.env.ENFORCE_HTTPS === '1';
const PUBLIC_ORIGIN = (() => {
  if (!process.env.PUBLIC_ORIGIN) return '';
  try {
    const value = new URL(process.env.PUBLIC_ORIGIN);
    return value.protocol === 'https:' && !value.username && !value.password ? value.origin : '';
  } catch { return ''; }
})();
if (ENFORCE_HTTPS && !PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN=https://example.com is required when ENFORCE_HTTPS=1');
const ASSET_FILES = ['common.js','home.js','company.js','trending.js','article.js','about.js','styles.css','manifest.webmanifest','sw.js'];
const ASSET_VERSION = `ainews-${crypto.createHash('sha256').update(ASSET_FILES.map(file => {
  try { return fs.readFileSync(path.join(PUBLIC_DIR, file)); } catch { return Buffer.alloc(0); }
}).reduce((all, value) => Buffer.concat([all, value]), Buffer.alloc(0))).digest('hex').slice(0, 12)}`;

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
let refreshStateUpdatedAt = 0;
let lastForceRefreshAt = 0;
const forceByIp = new Map();
let shuttingDown = false;

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
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&hellip;/gi, '…')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => decodeCodePoint(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => decodeCodePoint(parseInt(n, 16)));
}

function truncateCodePoints(value, max, suffix = '') {
  const chars = [...String(value || '')];
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, Math.max(0, max - [...suffix].length)).join('').trimEnd() + suffix;
}

function parseTagAt(xml, start) {
  if (xml[start] !== '<') return null;
  if (xml.startsWith('<!--', start)) {
    const end = xml.indexOf('-->', start + 4);
    return { special: true, end: end < 0 ? xml.length : end + 3 };
  }
  if (xml.startsWith('<![CDATA[', start)) {
    const end = xml.indexOf(']]>', start + 9);
    return { special: true, end: end < 0 ? xml.length : end + 3 };
  }
  let end = start + 1;
  let quote = '';
  for (; end < xml.length; end++) {
    const ch = xml[end];
    if (quote) { if (ch === quote) quote = ''; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') break;
  }
  if (end >= xml.length) return null;
  const raw = xml.slice(start + 1, end).trim();
  if (!raw || raw[0] === '!' || raw[0] === '?') return { special: true, end: end + 1 };
  const closing = raw[0] === '/';
  const body = closing ? raw.slice(1).trim() : raw;
  const selfClosing = !closing && /\/$/.test(body);
  const name = (body.match(/^([^\s/>]+)/) || [,''])[1].toLowerCase();
  return { name, closing, selfClosing, raw: body, end: end + 1 };
}

function elementBlocks(xml, wanted) {
  const source = String(xml || '');
  const name = String(wanted).toLowerCase();
  const out = [];
  const stack = [];
  let pos = 0;
  while ((pos = source.indexOf('<', pos)) >= 0) {
    const tag = parseTagAt(source, pos);
    if (!tag) break;
    if (!tag.special && tag.name === name) {
      if (!tag.closing && !tag.selfClosing) stack.push({ contentStart: tag.end, openStart: pos, tag });
      else if (tag.closing && stack.length) {
        const open = stack.pop();
        if (!stack.length) out.push({ content: source.slice(open.contentStart, pos), openTag: open.tag.raw });
      }
    }
    pos = Math.max(tag.end, pos + 1);
  }
  return out;
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
  return elementBlocks(block, String(tag).replace(/[^A-Za-z0-9:_-]/g, ''))[0]?.content?.trim() || '';
}

function pickSource(block) {
  const node = elementBlocks(block, 'source')[0];
  if (!node) return { url: '', name: '' };
  const attrs = node.openTag.replace(/^source\b/i, '');
  const match = attrs.match(/(?:^|\s)url\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return { url: safeHttpUrl(decodeXml(match?.[1] || match?.[2] || '')), name: stripHtml(node.content) };
}

function safeHttpUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0:0:0:0:0:0:0:1') return '';
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const octets = ipv4.slice(1).map(Number);
      if (octets.some(x => x > 255) || octets[0] === 10 || octets[0] === 127 || octets[0] === 0 ||
          (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
          (octets[0] === 192 && octets[1] === 168) || octets[0] >= 224) return '';
    }
    if (host.includes(':') && (/^(fc|fd|fe8|fe9|fea|feb)/i.test(host) || host === '::')) return '';
    return u.href;
  } catch { return ''; }
}

function isGenericPublisherUrl(value) {
  try {
    const pathname = new URL(value).pathname.replace(/\/+$/, '') || '/';
    return pathname === '/' || /^\/(news|blog)$/i.test(pathname);
  } catch { return true; }
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
      if (next && /^\d+(?:\.\d+)*$/.test(next) && /^(gpt|gemini|claude|llama|opus|sonnet|flash)$/i.test(w)) {
        tokens.add(`model:${w}:${next}`);
        const suffix = words[i + 2];
        if (suffix && /^(o|pro|flash|mini|turbo)$/i.test(suffix)) tokens.add(`model:${w}:${next}:${suffix}`);
      }
      const next2 = words[i + 2];
      if (next2 && /^\d+(?:\.\d+)*$/.test(next2) && /^(gpt|gemini|claude|llama)$/i.test(w) && /^(o|pro|flash|mini|turbo)$/i.test(next || '')) tokens.add(`model:${w}:${next}:${next2}`);
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
  const text = `${article?.title || ''} ${article?.summary || ''} ${article?.source || ''}`.toLowerCase().normalize('NFKC');
  const categories = new Set();
  const companies = new Set();

  const falseContext = {
    openai: /\b(ancient|medieval|manuscript|book)\s+codex\b/i,
    google: /\b(gemini\s+(horoscope|zodiac|astrology)|project\s+gemini|gemini\s+spacecraft)\b/i,
    anthropic: /\bclaude\s+monet\b/i,
    nvidia: /\bblackwell\s+(school|academy|publishing|bookshop)\b/i,
    amazon: /\bamazon\s+(rainforest|river|basin|tribe|forest)\b/i
  };

  if (hasAny(text, ['openai','chatgpt','gpt','codex']) && !falseContext.openai.test(text)) companies.add('openai');
  if (hasAny(text, ['google','deepmind','gemini','gemma']) && !falseContext.google.test(text)) companies.add('google');
  if (hasAny(text, ['anthropic','claude']) && !falseContext.anthropic.test(text)) companies.add('anthropic');
  if (hasAny(text, ['nvidia','cuda','rubin','blackwell']) && !falseContext.nvidia.test(text)) companies.add('nvidia');
  if (hasAny(text, ['meta','llama'])) companies.add('meta');
  if (hasAny(text, ['microsoft','copilot','azure'])) companies.add('microsoft');
  if (hasAny(text, ['xai','grok'])) companies.add('xai');
  if (hasAny(text, ['amazon','aws']) && !falseContext.amazon.test(text)) companies.add('amazon');

  if (hasAny(text, ['model','models','gpt','gemini','claude','llama','benchmark','reasoning','agent','モデル','推論','エージェント','ベンチマーク'])) categories.add('models');
  if (hasAny(text, ['chip','chips','gpu','data center','datacenter','compute','nvidia','semiconductor','cloud','チップ','半導体','データセンター','計算資源','クラウド','gpu'])) categories.add('infrastructure');
  if (hasAny(text, ['safety','security','cyber','jailbreak','risk','regulation','policy','law','laws','copyright','安全','安全性','セキュリティ','サイバー','規制','政策','法律','著作権','リスク'])) categories.add('safety');
  if (hasAny(text, ['research','study','paper','science','scientist','benchmark','robotics','研究','論文','科学','科学者','ロボット','ロボティクス'])) categories.add('research');
  if (hasAny(text, ['funding','acquire','acquisition','revenue','earnings','deal','partnership','startup','joins','資金調達','買収','売上','決算','提携','スタートアップ','参画','就任'])) categories.add('business');
  if (!categories.size) categories.add('general');

  return { categories: [...categories], companies: [...companies] };
}

function normalizePublishedAt(raw, now = Date.now()) {
  const value = String(raw || '').trim();
  const isoDate = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
  if (isoDate) {
    const year = Number(isoDate[1]), month = Number(isoDate[2]), day = Number(isoDate[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (ms > now) return null;
  return new Date(ms).toISOString();
}

function articleTime(a) {
  const ms = Date.parse(a?.publishedAt || '');
  return Number.isFinite(ms) ? ms : 0;
}

function parseRss(xml, feed) {
  const out = [];
  const items = elementBlocks(xml, 'item');
  for (const item of items) {
    const block = item.content;
    let title = stripHtml(pickTagRaw(block, 'title'));
    const link = safeHttpUrl(stripHtml(pickTagRaw(block, 'link')));
    const pubDateRaw = stripHtml(pickTagRaw(block, 'pubDate'));
    const guid = stripHtml(pickTagRaw(block, 'guid'));
    const source = pickSource(block);
    let description = stripHtml(pickTagRaw(block, 'description'));

    if (!title || !link) continue;
    if (source.name && title.endsWith(` - ${source.name}`)) title = title.slice(0, -(` - ${source.name}`.length));

    const publishedAt = normalizePublishedAt(pubDateRaw);
    if (pubDateRaw && !publishedAt) continue;
    description = truncateCodePoints(description, 560, '…');
    const normalizedDescription = normalizeTitle(description);
    const redundant = normalizedDescription === normalizeTitle(title) ||
      normalizedDescription === normalizeTitle(`${title} ${source.name || ''}`) ||
      normalizedDescription.startsWith(normalizeTitle(`${title} ${source.name || ''}`));
    if (redundant) description = '';

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
    if (out.length >= 45) break;
  }
  return out;
}

async function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  if (process.env.DISABLE_NETWORK === '1') throw new Error('network disabled');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (!/(?:application|text)\/(?:rss\+xml|atom\+xml|xml|[^;]+\+xml)/.test(type)) throw new Error(`Unexpected RSS content-type: ${type || 'missing'}`);
    if (Number(res.headers.get('content-length') || 0) > MAX_RSS_BYTES) throw new Error('RSS response too large');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('RSS response body missing');
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RSS_BYTES) { await reader.cancel(); throw new Error('RSS response too large'); }
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(x => Buffer.from(x))));
  } finally {
    clearTimeout(timer);
  }
}

function mergeExact(items) {
  const groups = new Map();
  for (const item of [...items].sort((a, b) => articleTime(b) - articleTime(a))) {
    const key = normalizeTitle(item.title);
    if (!key) continue;
    const candidates = groups.get(key) || [];
    const currentTime = articleTime(item);
    let prev = candidates.find(x => {
      const previousTime = articleTime(x);
      return item.url === x.url || !currentTime || !previousTime || Math.abs(currentTime - previousTime) <= EXACT_WINDOW_MS;
    });
    if (!prev) {
      prev = {
        ...item,
        feedKeys: [...new Set(item.feedKeys || [])],
        feedLabels: [...new Set(item.feedLabels || [])],
        companies: [...new Set(item.companies || [])],
        categories: [...new Set(item.categories || [])],
        sourceNames: [...new Set(item.sourceNames || [item.source])],
        mentionCount: 1
      };
      candidates.push(prev);
      groups.set(key, candidates);
      continue;
    }

    prev.feedKeys = [...new Set([...prev.feedKeys, ...(item.feedKeys || [])])];
    prev.feedLabels = [...new Set([...prev.feedLabels, ...(item.feedLabels || [])])];
    prev.companies = [...new Set([...prev.companies, ...(item.companies || [])])];
    prev.categories = [...new Set([...prev.categories, ...(item.categories || [])])];
    prev.sourceNames = [...new Set([...prev.sourceNames, ...(item.sourceNames || [item.source])])];
    prev.mentionCount = prev.sourceNames.length;
    if (!prev.summary && item.summary) prev.summary = item.summary;
  }
  return [...groups.values()].flat();
}

function modelTokens(tokens) {
  return [...tokens].filter(x => x.startsWith('model:'));
}

function modelVersionsCompatible(left, right) {
  const a = modelTokens(left), b = modelTokens(right);
  if (!a.length || !b.length) return true;
  const family = x => x.split(':').slice(0, 2).join(':');
  for (const x of a) for (const y of b) if (family(x) === family(y) && x !== y) return false;
  return true;
}

function buildClusters(articles) {
  const clusters = [];
  const sorted = [...articles].sort((a, b) => articleTime(b) - articleTime(a));

  for (const article of sorted) {
    const tokens = tokenSet(article.title);
    let best = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      if (Math.abs(articleTime(article) - articleTime(cluster.representative)) > CLUSTER_WINDOW_MS) continue;
      const scores = cluster.items.map(x => jaccard(tokens, x.tokens));
      const score = scores.length ? Math.min(...scores) : 0;
      const versionsMatch = cluster.items.every(x => modelVersionsCompatible(tokens, x.tokens));
      if (score >= 0.48 && versionsMatch && score > bestScore) { bestScore = score; best = cluster; }
    }

    if (best) {
      best.items.push({ article, tokens });
      for (const s of article.sourceNames || [article.source]) best.sources.add(s);
      for (const x of article.feedKeys || []) best.feedKeys.add(x);
      best.mentions += 1;
    } else {
      clusters.push({
        representative: article,
        items: [{ article, tokens }],
        tokens,
        sources: new Set(article.sourceNames || [article.source]),
        feedKeys: new Set(article.feedKeys || []),
        mentions: 1
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
    const members = cluster.items.map(x => x.article);
    const companies = [...new Set(members.flatMap(x => x.companies || []))];
    const categories = [...new Set(members.flatMap(x => x.categories || []))];
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
      relatedIds: [...new Set(members.map(x => x.id))]
    };
  }).sort((a, b) => b.score - a.score || articleTime(b) - articleTime(a));
}

function selectBalanced(items, limit = MAX_ARTICLES) {
  const sorted = [...items].sort((a, b) => articleTime(b) - articleTime(a));
  const selected = [];
  const used = new Set();
  const minimumPerFeed = Math.max(1, Math.floor(limit / (feeds.length * 3)));
  for (const feed of feeds) {
    let count = 0;
    for (const article of sorted) {
      if (count >= minimumPerFeed) break;
      if (!used.has(article.id) && (article.feedKeys || []).includes(feed.key)) {
        selected.push(article); used.add(article.id); count++;
      }
    }
  }
  for (const article of sorted) {
    if (selected.length >= limit) break;
    if (!used.has(article.id)) { selected.push(article); used.add(article.id); }
  }
  return selected.sort((a, b) => articleTime(b) - articleTime(a));
}

function normalizeArticle(a, origin = 'cache') {
  if (!a || typeof a !== 'object') return null;
  const title = String(a.title || '').trim();
  const url = safeHttpUrl(a.url);
  if (!title || !url) return null;
  const source = truncateCodePoints(String(a.source || 'Unknown').trim(), 200) || 'Unknown';
  const article = {
    id: /^[a-zA-Z0-9_-]{4,80}$/.test(String(a.id || '')) ? String(a.id) : stableId(a.guid || url || title),
    title: truncateCodePoints(title, 600),
    url,
    sourceUrl: safeHttpUrl(a.sourceUrl),
    source,
    publishedAt: normalizePublishedAt(a.publishedAt),
    summary: truncateCodePoints(String(a.summary || '').replace(/\s+/g, ' ').trim(), 560),
    feedKeys: Array.isArray(a.feedKeys) ? a.feedKeys.filter(x => typeof x === 'string').map(x => truncateCodePoints(x, 40)).slice(0, 20) : [],
    feedLabels: Array.isArray(a.feedLabels) ? a.feedLabels.filter(x => typeof x === 'string').map(x => truncateCodePoints(x, 80)).slice(0, 20) : [],
    locale: truncateCodePoints(String(a.locale || ''), 20),
    origin: a.origin === 'live' || a.origin === 'fallback' ? a.origin : origin,
    sourceNames: Array.isArray(a.sourceNames) ? a.sourceNames.filter(x => typeof x === 'string').map(x => truncateCodePoints(x, 200)).slice(0, 30) : [source],
    mentionCount: Math.min(1000, Math.max(1, Number(a.mentionCount) || 1))
  };
  Object.assign(article, classify(article));
  return article;
}

function normalizePayload(raw, modeHint = 'cache', { requireSchema = false } = {}) {
  if (!raw || !Array.isArray(raw.articles)) return null;
  if (requireSchema && raw.schema !== CACHE_SCHEMA) return null;
  const articles = raw.articles.slice(0, 1000).map(a => normalizeArticle(a, modeHint)).filter(Boolean).slice(0, MAX_ARTICLES);
  if (!articles.length) return null;
  return {
    schema: CACHE_SCHEMA,
    generatedAt: normalizePublishedAt(raw.generatedAt) || new Date().toISOString(),
    fetchedAt: normalizePublishedAt(raw.fetchedAt) || new Date().toISOString(),
    mode: ['live','stale-cache','fallback'].includes(raw.mode) ? raw.mode : modeHint,
    degraded: Boolean(raw.degraded),
    fetchDurationMs: Number.isFinite(Number(raw.fetchDurationMs)) ? Number(raw.fetchDurationMs) : null,
    sourceStats: Array.isArray(raw.sourceStats) ? raw.sourceStats.slice(0, 30).map(x => ({
      key: truncateCodePoints(x?.key, 40), label: truncateCodePoints(x?.label, 80), ok: Boolean(x?.ok),
      count: Math.max(0, Math.min(1000, Number(x?.count) || 0)), error: truncateCodePoints(x?.error, 200)
    })) : [],
    articles,
    trending: buildClusters(articles)
  };
}

async function readJson(file, { quietMissing = true } = {}) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (err) {
    if (!(quietMissing && err?.code === 'ENOENT')) console.error(`failed to read ${path.basename(file)}:`, err.message);
    return null;
  }
}

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fsp.open(tmp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tmp, file);
    let dir;
    try { dir = await fsp.open(path.dirname(file), 'r'); await dir.sync(); } catch {} finally { if (dir) await dir.close().catch(() => {}); }
  } finally {
    if (handle) await handle.close().catch(() => {});
    fsp.unlink(tmp).catch(() => {});
  }
}

async function loadFallback() {
  const raw = await readJson(FALLBACK_FILE);
  const base = normalizePayload({ ...raw, mode: 'fallback', degraded: true }, 'fallback');
  if (!base) return { schema: CACHE_SCHEMA, generatedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), mode: 'fallback', degraded: true, sourceStats: [], articles: [], trending: [] };
  base.contentGeneratedAt = base.generatedAt;
  base.fetchedAt = base.generatedAt;
  for (const article of base.articles) {
    if (isGenericPublisherUrl(article.url)) article.url = `https://news.google.com/search?q=${encodeURIComponent(`"${article.title}"`)}`;
  }
  base.mode = 'fallback';
  base.degraded = true;
  base.sourceStats = [{ key: 'fallback', label: '内蔵フォールバック', ok: true, count: base.articles.length }];
  return base;
}

async function loadDiskCache() {
  return normalizePayload(await readJson(CACHE_FILE), 'stale-cache', { requireSchema: true });
}

async function persistRuntimeState({ lockHeld = false } = {}) {
  const release = lockHeld ? null : await acquireRateLock();
  if (!lockHeld && !release) return false;
  try {
    const persisted = await readJson(RUNTIME_FILE);
    if (persisted?.schema === 1) {
      for (const row of Array.isArray(persisted.forceByIp) ? persisted.forceByIp.slice(0, 1000) : []) {
        if (Array.isArray(row) && typeof row[0] === 'string' && Number(row[1]) > (forceByIp.get(row[0]) || 0)) forceByIp.set(row[0], Number(row[1]));
      }
      if (Number(persisted.refreshStateUpdatedAt) > refreshStateUpdatedAt) {
        refreshStateUpdatedAt = Number(persisted.refreshStateUpdatedAt);
        nextRefreshAllowedAt = Math.max(0, Number(persisted.nextRefreshAllowedAt) || 0);
        consecutiveRefreshFailures = Math.max(0, Math.min(20, Number(persisted.consecutiveRefreshFailures) || 0));
      }
    }
    const forceEntries = [...forceByIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1000);
    await writeJsonAtomic(RUNTIME_FILE, {
      schema: 1, refreshStateUpdatedAt, nextRefreshAllowedAt, consecutiveRefreshFailures, lastForceRefreshAt, forceByIp: forceEntries
    });
    return true;
  } catch (err) {
    console.error('runtime state write failed:', err.message);
    return false;
  } finally {
    if (release) await release();
  }
}

async function loadRuntimeState() {
  const state = await readJson(RUNTIME_FILE);
  if (!state || state.schema !== 1) return;
  nextRefreshAllowedAt = Math.max(0, Number(state.nextRefreshAllowedAt) || 0);
  consecutiveRefreshFailures = Math.max(0, Math.min(20, Number(state.consecutiveRefreshFailures) || 0));
  refreshStateUpdatedAt = Math.max(0, Number(state.refreshStateUpdatedAt) || 0);
  lastForceRefreshAt = Math.max(0, Number(state.lastForceRefreshAt) || 0);
  const now = Date.now();
  for (const row of Array.isArray(state.forceByIp) ? state.forceByIp.slice(0, 1000) : []) {
    if (Array.isArray(row) && typeof row[0] === 'string' && now - Number(row[1]) < FORCE_IP_INTERVAL_MS * 2) forceByIp.set(row[0], Number(row[1]));
  }
}

async function acquireRefreshLock() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    const handle = await fsp.open(REFRESH_LOCK_FILE, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
    return async () => { await handle.close().catch(() => {}); await fsp.unlink(REFRESH_LOCK_FILE).catch(() => {}); };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    try {
      const stat = await fsp.stat(REFRESH_LOCK_FILE);
      if (Date.now() - stat.mtimeMs > Math.max(FETCH_TIMEOUT_MS * 2, 60_000)) {
        await fsp.unlink(REFRESH_LOCK_FILE);
        return acquireRefreshLock();
      }
    } catch {}
    return null;
  }
}

async function acquireRateLock() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    const handle = await fsp.open(RATE_LOCK_FILE, 'wx', 0o600);
    return async () => { await handle.close().catch(() => {}); await fsp.unlink(RATE_LOCK_FILE).catch(() => {}); };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    try {
      const stat = await fsp.stat(RATE_LOCK_FILE);
      if (Date.now() - stat.mtimeMs > 30_000) { await fsp.unlink(RATE_LOCK_FILE); return acquireRateLock(); }
    } catch {}
    return null;
  }
}

function registerRefreshFailure() {
  consecutiveRefreshFailures += 1;
  const backoff = Math.min(15 * 60 * 1000, 15_000 * (2 ** Math.min(6, consecutiveRefreshFailures - 1)));
  nextRefreshAllowedAt = Date.now() + backoff;
  refreshStateUpdatedAt = Date.now();
  persistRuntimeState();
}

function registerRefreshSuccess() {
  consecutiveRefreshFailures = 0;
  nextRefreshAllowedAt = Date.now() + REFRESH_MIN_INTERVAL_MS;
  refreshStateUpdatedAt = Date.now();
  persistRuntimeState();
}

async function refreshNews({ force = false } = {}) {
  if (refreshPromise) return refreshPromise;
  if (!force && Date.now() < nextRefreshAllowedAt) return memoryCache || await loadDiskCache() || await loadFallback();

  refreshPromise = (async () => {
    const releaseLock = await acquireRefreshLock();
    if (!releaseLock) return memoryCache || await loadDiskCache() || await loadFallback();
    const startedAt = Date.now();
    try {
      lastRefreshAttemptAt = startedAt;
      const prior = memoryCache || await loadDiskCache();
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
          sourceStats.push({ key: feed.key, label: feed.label, ok: false, count: 0, error: truncateCodePoints(String(r.reason?.message || r.reason || 'fetch failed'), 200) });
        }
      }

      const merged = selectBalanced(mergeExact(articles), MAX_ARTICLES);
      const successfulFeeds = sourceStats.filter(x => x.ok).length;
      const priorCount = prior?.articles?.length || 0;
      const dangerouslySmall = !refreshQualitySafe(merged.length, successfulFeeds, priorCount);
      if (dangerouslySmall) {
        registerRefreshFailure();
        if (prior?.articles?.length) {
          const stale = { ...prior, mode: 'stale-cache', degraded: true, sourceStats, trending: buildClusters(prior.articles) };
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
      try {
        await writeJsonAtomic(CACHE_FILE, payload);
      } catch (err) {
        registerRefreshFailure();
        console.error('cache write failed:', err.message);
        return { ...payload, mode: 'stale-cache', degraded: true, persistenceError: true };
      }
      memoryCache = payload;
      registerRefreshSuccess();
      return payload;
    } finally {
      await releaseLock();
    }
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
  const encodings = new Map();
  for (const part of String(header).split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const rawQ = params.map(x => x.trim()).find(x => /^q=/.test(x));
    const q = rawQ ? Number(rawQ.slice(2)) : 1;
    encodings.set(name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0);
  }
  return (encodings.has('gzip') ? encodings.get('gzip') : encodings.get('*') || 0) > 0;
}

function refreshQualitySafe(articleCount, successfulFeeds, priorCount = 0) {
  if (articleCount < 8 || successfulFeeds < Math.ceil(feeds.length / 2)) return false;
  if (priorCount >= 20 && articleCount < Math.ceil(priorCount * 0.65)) return false;
  return true;
}

function isSecureRequest(req) {
  if (req.socket?.encrypted) return true;
  return TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function applySecurityHeaders(req, res, requestId) {
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('content-security-policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self'");
  if (isSecureRequest(req)) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

async function json(res, status, body, req, { cacheControl = 'no-store' } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const canGzip = req.method !== 'HEAD' && acceptsGzip(req.headers['accept-encoding']) && raw.length > 1024;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheControl);
  res.setHeader('vary', 'Accept-Encoding');
  if (req.method === 'HEAD') { res.setHeader('content-length', raw.length); return res.end(); }
  if (canGzip) {
    try {
      const gz = await gzipAsync(raw, { level: zlib.constants.Z_BEST_SPEED });
      res.setHeader('content-encoding', 'gzip');
      res.setHeader('content-length', gz.length);
      return res.end(gz);
    } catch {}
  }
  res.setHeader('content-length', raw.length);
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
    const raw = await fsp.readFile(file);
    const served = path.basename(file) === 'sw.js' ? Buffer.from(raw.toString('utf8').replace('__ASSET_VERSION__', ASSET_VERSION)) : raw;
    const buf = req.method === 'HEAD' ? null : served;
    res.statusCode = 200;
    res.setHeader('content-type', mime[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('cache-control', path.basename(file) === 'sw.js' ? 'no-cache' : /\.(css|js|svg|png|webmanifest)$/.test(file) ? 'public, max-age=300' : 'no-cache');
    res.setHeader('content-length', req.method === 'HEAD' ? served.length : buf.length);
    res.end(buf || undefined);
    return true;
  } catch { return false; }
}

function clientIp(req) {
  const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return String(forwarded || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '').slice(0, 200);
}

async function allowForceRefresh(req) {
  const release = await acquireRateLock();
  if (!release) return { allowed: false, reason: 'rate_state_busy' };
  try {
    const persisted = await readJson(RUNTIME_FILE);
    if (persisted?.schema === 1) {
      forceByIp.clear();
      for (const row of Array.isArray(persisted.forceByIp) ? persisted.forceByIp.slice(0, 1000) : []) {
        if (Array.isArray(row) && typeof row[0] === 'string') forceByIp.set(row[0], Number(row[1]) || 0);
      }
    }
  const now = Date.now();
  for (const [key, ts] of forceByIp) if (now - ts > FORCE_IP_INTERVAL_MS * 2) forceByIp.delete(key);
  while (forceByIp.size >= 1000) forceByIp.delete(forceByIp.keys().next().value);
  const ip = stableId(clientIp(req));
  const previous = forceByIp.get(ip) || 0;
  if (now - previous < FORCE_IP_INTERVAL_MS) return { allowed: false, reason: 'client_cooldown' };
  lastForceRefreshAt = now;
  forceByIp.set(ip, now);
  await persistRuntimeState({ lockHeld: true });
  return { allowed: true, reason: 'allowed' };
  } finally {
    await release();
  }
}

function isSameOrigin(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return !req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin';
  try {
    const expectedProtocol = isSecureRequest(req) ? 'https:' : 'http:';
    const expected = PUBLIC_ORIGIN || `${expectedProtocol}//${req.headers.host || 'localhost'}`;
    return new URL(origin).origin === expected;
  } catch { return false; }
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
  const requestId = /^[A-Za-z0-9._-]{8,80}$/.test(String(req.headers['x-request-id'] || '')) ? String(req.headers['x-request-id']) : crypto.randomUUID();
  const startedAt = Date.now();
  applySecurityHeaders(req, res, requestId);
  res.once('finish', () => console.log(JSON.stringify({ requestId, method: req.method, path: String(req.url || '').split('?')[0], status: res.statusCode, durationMs: Date.now() - startedAt })));
  try {
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
      res.setHeader('allow', 'GET, HEAD, POST');
      return json(res, 405, { error: 'method_not_allowed' }, req);
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (ENFORCE_HTTPS && !isSecureRequest(req)) {
      res.statusCode = 308;
      res.setHeader('location', `${PUBLIC_ORIGIN}${req.url || '/'}`);
      return res.end();
    }

    if (req.method === 'POST' && pathname !== '/api/refresh') {
      res.setHeader('allow', 'GET, HEAD');
      return json(res, 405, { error: 'method_not_allowed' }, req);
    }

    if (pathname === '/api/refresh') {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return json(res, 405, { error: 'method_not_allowed' }, req);
      }
      if (!isSameOrigin(req)) throw new HttpError(403, 'cross_origin_refresh_denied');
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0) {
        req.resume();
        throw new HttpError(413, 'refresh_body_not_allowed');
      }
      const permit = await allowForceRefresh(req);
      if (!permit.allowed) return json(res, 429, { error: 'refresh_throttled', reason: permit.reason }, req);
      const payload = await getNews({ force: true });
      return json(res, 200, { meta: metaFrom(payload, { refreshStatus: payload.mode === 'live' ? 'updated' : 'degraded', refreshReason: permit.reason }) }, req);
    }

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
      const payload = await getNews();
      const result = queryArticles(payload, url.searchParams);
      return json(res, 200, { meta: metaFrom(payload, { refreshStatus: 'none', refreshReason: 'not_requested' }), ...result }, req);
    }

    if (pathname === '/api/snapshot') {
      const payload = await getNews();
      return json(res, 200, payload, req, { cacheControl: 'private, max-age=0, must-revalidate' });
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
        for (const sourceName of a.sourceNames || [a.source]) sourceMap.set(sourceName, (sourceMap.get(sourceName) || 0) + 1);
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
    const notFound = Buffer.from('404 Not Found');
    res.setHeader('content-length', notFound.length);
    res.end(req.method === 'HEAD' ? undefined : notFound);
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
        await loadRuntimeState();
        if (!memoryCache) memoryCache = await loadDiskCache();
        const age = Date.now() - (Date.parse(memoryCache?.generatedAt || '') || 0);
        if ((!memoryCache?.articles?.length || age >= CACHE_TTL_MS) && Date.now() >= nextRefreshAllowedAt) {
          refreshNews().catch(err => { registerRefreshFailure(); console.error('startup refresh failed:', err.message); });
        }
      } catch (err) { console.error('startup initialization failed:', err.message); }
      resolve(server);
    });
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref();
  await new Promise(resolve => server.close(() => resolve()));
  if (refreshPromise) await Promise.race([refreshPromise.catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
  await persistRuntimeState();
  clearTimeout(timer);
}

if (require.main === module) {
  startServer().catch(err => { console.error(err); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(signal).then(() => { process.exitCode = 0; }));
}

module.exports = {
  server,
  startServer,
  shutdown,
  decodeXml,
  stripHtml,
  safeHttpUrl,
  isGenericPublisherUrl,
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
  acceptsGzip,
  refreshNews,
  getNews,
  metaFrom,
  selectBalanced,
  refreshQualitySafe,
  fetchText
};
