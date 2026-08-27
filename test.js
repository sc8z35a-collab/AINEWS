'use strict';

const assert = require('node:assert/strict');
const {
  decodeXml,
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
} = require('./server');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

test('AWS classification uses word boundaries', () => {
  assert.equal(classify({ title: 'New AI laws draw criticism', source: 'Reuters' }).companies.includes('amazon'), false);
  assert.equal(classify({ title: 'AWS launches new AI service', source: 'Reuters' }).companies.includes('amazon'), true);
});

test('Meta classification does not match metadata', () => {
  assert.equal(classify({ title: 'New metadata standard for AI', source: 'Example' }).companies.includes('meta'), false);
  assert.equal(classify({ title: 'Meta launches Llama update', source: 'Example' }).companies.includes('meta'), true);
});

test('Japanese category keywords are classified', () => {
  const c = classify({ title: 'AI規制と著作権、安全性に関する研究論文', source: 'Example' });
  assert(c.categories.includes('safety'));
  assert(c.categories.includes('research'));
});

test('Japanese titles produce useful similarity tokens', () => {
  const a = tokenSet('OpenAIが新モデルを正式発表');
  const b = tokenSet('OpenAI、新モデルを発表');
  assert(jaccard(a, b) > 0.2);
});

test('Model version tokens preserve version differences', () => {
  const a = tokenSet('OpenAI launches GPT-4 model');
  const b = tokenSet('OpenAI launches GPT-5 model');
  assert(a.has('gpt:4'));
  assert(b.has('gpt:5'));
  assert.notEqual([...a].sort().join('|'), [...b].sort().join('|'));
});

test('Unicode numeric entities decode supplementary code points', () => {
  assert.equal(decodeXml('hello &#128512;'), 'hello 😀');
});

test('Unsafe URL schemes are rejected', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl('data:text/html,test'), '');
  assert.match(safeHttpUrl('https://example.com/a'), /^https:\/\/example\.com\/a/);
});

test('Invalid dates remain unknown instead of becoming now', () => {
  assert.equal(normalizePublishedAt('not-a-date'), null);
});

test('Far-future dates are clamped to current time', () => {
  const now = Date.now();
  const value = normalizePublishedAt('2099-01-01T00:00:00Z', now);
  assert.equal(value, new Date(now).toISOString());
});

test('RSS parser rejects unsafe links and accepts valid articles', () => {
  const feed = { key: 'x', label: 'X', locale: 'en-US' };
  const xml = `<rss><channel>
    <item><title>Bad</title><link>javascript:alert(1)</link><pubDate>Tue, 25 Aug 2026 00:00:00 GMT</pubDate></item>
    <item><title>Good</title><link>https://example.com/good</link><pubDate>Tue, 25 Aug 2026 00:00:00 GMT</pubDate><source url="https://example.com">Example</source></item>
  </channel></rss>`;
  const rows = parseRss(xml, feed);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Good');
});

test('Exact merge preserves source diversity and latest representative', () => {
  const base = {
    id: 'aaaa', title: 'Same Story', url: 'https://a.example/x', sourceUrl: 'https://a.example', source: 'A',
    publishedAt: '2026-08-27T01:00:00Z', summary: '', feedKeys: ['global'], feedLabels: ['Global'], locale: 'en-US', origin: 'live',
    companies: ['openai'], categories: ['models'], sourceNames: ['A'], mentionCount: 1
  };
  const newer = {
    ...base, id: 'bbbb', url: 'https://b.example/x', sourceUrl: 'https://b.example', source: 'B',
    publishedAt: '2026-08-27T02:00:00Z', summary: 'new', feedKeys: ['openai'], feedLabels: ['OpenAI'],
    companies: ['microsoft'], categories: ['business'], sourceNames: ['B']
  };
  const [m] = mergeExact([base, newer]);
  assert.equal(m.id, 'aaaa');
  assert.equal(m.source, 'B');
  assert.equal(m.mentionCount, 2);
  assert.deepEqual(new Set(m.sourceNames), new Set(['A','B']));
  assert(m.companies.includes('openai') && m.companies.includes('microsoft'));
  assert(m.categories.includes('models') && m.categories.includes('business'));
});

test('Trending uses preserved duplicate source count', () => {
  const article = {
    id: 'aaaa', title: 'OpenAI launches GPT-5', source: 'B', publishedAt: new Date().toISOString(),
    companies: ['openai'], categories: ['models'], feedKeys: ['global','openai'], sourceNames: ['A','B'], mentionCount: 2
  };
  const [trend] = buildClusters([article]);
  assert.equal(trend.sourceCount, 2);
  assert.equal(trend.mentionCount, 2);
});

test('API integer parser rejects NaN and out-of-range values', () => {
  assert.throws(() => parseBoundedInt('abc', 10, 1, 180, 'limit'), e => e.status === 400);
  assert.throws(() => parseBoundedInt('181', 10, 1, 180, 'limit'), e => e.status === 400);
  assert.equal(parseBoundedInt('25', 10, 1, 180, 'limit'), 25);
});

test('gzip negotiation respects q=0', () => {
  assert.equal(acceptsGzip('gzip;q=0, br'), false);
  assert.equal(acceptsGzip('br, gzip;q=0.5'), true);
});

test('Generic-only category does not create fake related articles', () => {
  const target = { id:'a', title:'Completely different topic', companies:[], categories:['general'], publishedAt:'2026-08-27T00:00:00Z' };
  const unrelated = { id:'b', title:'Another unrelated event', companies:[], categories:['general'], publishedAt:'2026-08-27T00:00:00Z' };
  assert.equal(relatedArticles({ articles:[target,unrelated] }, target).length, 0);
});

test('Cache normalization rejects malformed articles and rebuilds classifications', () => {
  const payload = normalizePayload({ articles:[
    { id:'good1', title:'AWS AI launch', url:'https://example.com/x', source:'Example', publishedAt:'2026-08-27T00:00:00Z' },
    { id:'bad01', title:'Bad', url:'javascript:alert(1)', source:'Bad' }
  ]});
  assert.equal(payload.articles.length, 1);
  assert(payload.articles[0].companies.includes('amazon'));
  assert(Array.isArray(payload.trending));
});

test('Title normalization remains deterministic', () => {
  assert.equal(normalizeTitle('  GPT—5: “Test”  '), 'gpt 5 test');
});

console.log(`\n${passed} regression tests passed.`);
