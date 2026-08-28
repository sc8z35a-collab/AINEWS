'use strict';

const assert = require('node:assert/strict');
const {
  decodeXml, safeHttpUrl, isGenericPublisherUrl, normalizeTitle, tokenSet, jaccard, classify, normalizePublishedAt,
  parseRss, mergeExact, buildClusters, normalizePayload, parseBoundedInt, relatedArticles,
  acceptsGzip, selectBalanced, refreshQualitySafe
} = require('./server');

let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`✓ ${name}`); } catch (err) { console.error(`✗ ${name}`); throw err; } }
function article(id,title,time='2026-08-27T02:00:00Z',extra={}) { return { id,title,url:`https://example.com/${id}`,sourceUrl:'https://example.com/',source:'Example',publishedAt:time,summary:'',feedKeys:['global'],feedLabels:['Global'],locale:'en-US',origin:'live',companies:[],categories:['models'],sourceNames:['Example'],mentionCount:1,...extra }; }

test('company classification uses boundaries, context and summaries', () => {
  assert.equal(classify({ title:'New AI laws draw criticism', source:'Reuters' }).companies.includes('amazon'), false);
  assert.equal(classify({ title:'Claude Monet exhibition opens', source:'Museum' }).companies.includes('anthropic'), false);
  assert.equal(classify({ title:'Gemini horoscope for Friday', source:'Daily' }).companies.includes('google'), false);
  assert.equal(classify({ title:'Ancient codex found', source:'History' }).companies.includes('openai'), false);
  assert.equal(classify({ title:'Blackwell school expands', source:'Local' }).companies.includes('nvidia'), false);
  assert.equal(classify({ title:'Amazon rainforest study', source:'Science' }).companies.includes('amazon'), false);
  assert.equal(classify({ title:'Cloud platform update', summary:'AWS launches a new AI service', source:'Reuters' }).companies.includes('amazon'), true);
});

test('Japanese category keywords are classified', () => {
  const c=classify({title:'AI規制と著作権、安全性に関する研究論文',source:'Example'});
  assert(c.categories.includes('safety')); assert(c.categories.includes('research'));
});

test('Japanese titles produce useful similarity tokens', () => assert(jaccard(tokenSet('OpenAIが新モデルを正式発表'),tokenSet('OpenAI、新モデルを発表'))>0.2));

test('model tokens distinguish GPT-4, GPT-4o and GPT-5', () => {
  const a=tokenSet('OpenAI launches GPT-4 model'),b=tokenSet('OpenAI launches GPT-4o model'),c=tokenSet('OpenAI launches GPT-5 model');
  assert(a.has('model:gpt:4')); assert(b.has('model:gpt:4:o')); assert(c.has('model:gpt:5'));
  assert.notEqual([...a].sort().join('|'),[...b].sort().join('|'));
});

test('XML entities decode named spaces and supplementary code points', () => assert.equal(decodeXml('hello&nbsp;&#128512;'),'hello 😀'));

test('external URLs require public HTTPS without credentials', () => {
  for(const bad of ['javascript:alert(1)','data:text/html,test','http://example.com','https://user:pass@example.com','https://localhost/x','https://127.0.0.1/x','https://10.0.0.1/x','https://169.254.169.254/x','https://192.168.1.2/x'])assert.equal(safeHttpUrl(bad),'');
  assert.match(safeHttpUrl('https://example.com/a'),/^https:\/\/example\.com\/a/);
});

test('generic publisher landing pages are detected for fallback search links', () => {
  assert.equal(isGenericPublisherUrl('https://openai.com/news/'),true);assert.equal(isGenericPublisherUrl('https://example.com/blog'),true);assert.equal(isGenericPublisherUrl('https://example.com/news/specific-story'),false);
});

test('invalid calendar and future dates are rejected', () => {
  const now=Date.parse('2026-08-28T00:00:00Z');
  assert.equal(normalizePublishedAt('2026-02-30T00:00:00Z',now),null);
  assert.equal(normalizePublishedAt('2026-08-28T00:00:01Z',now),null);
  assert.equal(normalizePublishedAt('not-a-date',now),null);
});

test('RSS parser handles attribute order, single quotes and skips invalid rows before its limit', () => {
  const feed={key:'x',label:'X',locale:'en-US'};
  const bad=Array.from({length:46},(_,i)=>`<item><title>Bad ${i}</title><link>http://example.com/${i}</link></item>`).join('');
  const good=`<item><title>Good - Example</title><link>https://example.com/good</link><pubDate>Tue, 25 Aug 2026 00:00:00 GMT</pubDate><source type='publisher' url='https://example.com'>Example</source><description><![CDATA[Good&nbsp;Example]]></description></item>`;
  const rows=parseRss(`<rss><channel>${bad}${good}</channel></rss>`,feed);
  assert.equal(rows.length,1); assert.equal(rows[0].title,'Good'); assert.equal(rows[0].sourceUrl,'https://example.com/'); assert.equal(rows[0].summary,'');
});

test('RSS summary truncation preserves complete Unicode code points', () => {
  const feed={key:'x',label:'X',locale:'en-US'};const summary='😀'.repeat(700);
  const [row]=parseRss(`<item><title>Unicode</title><link>https://example.com/u</link><description>${summary}</description></item>`,feed);
  assert.equal([...row.summary].length,560); assert(row.summary.endsWith('…')); assert(!row.summary.includes('\uFFFD'));
});

test('exact merge keeps newest representative and does not merge distant same-title events', () => {
  const older=article('aaaa','Same Story','2026-08-24T01:00:00Z',{source:'A',sourceNames:['A']});
  const newer=article('bbbb','Same Story','2026-08-27T02:00:00Z',{source:'B',sourceNames:['B'],summary:'new'});
  const near=article('cccc','Same Story','2026-08-27T01:00:00Z',{source:'C',sourceNames:['C'],feedKeys:['openai']});
  const merged=mergeExact([older,near,newer]); assert.equal(merged.length,2);
  const current=merged.find(x=>x.id==='bbbb'); assert(current); assert.equal(current.source,'B'); assert.equal(current.mentionCount,2); assert.deepEqual(new Set(current.sourceNames),new Set(['B','C']));
});

test('clusters respect time windows and conflicting model versions', () => {
  const rows=[article('a001','OpenAI launches GPT-4 model today','2026-08-27T02:00:00Z'),article('a002','OpenAI launches GPT-4 model today','2026-08-27T01:00:00Z'),article('a003','OpenAI launches GPT-5 model today','2026-08-27T01:30:00Z'),article('a004','OpenAI launches GPT-4 model today','2026-08-20T01:00:00Z')];
  const clusters=buildClusters(rows); assert.equal(clusters.length,3); assert.equal(clusters.find(x=>x.relatedIds.includes('a001')).relatedIds.length,2);
});

test('trending source count uses all preserved source names without query inflation', () => {
  const [trend]=buildClusters([article('aaaa','OpenAI launches GPT-5','2026-08-27T02:00:00Z',{sourceNames:['A','B'],feedKeys:['global','openai'],mentionCount:99})]);
  assert.equal(trend.sourceCount,2); assert.equal(trend.mentionCount,1); assert.equal(trend.queryCount,2);
});

test('balanced selection preserves feed coverage before filling by freshness', () => {
  const rows=[];for(let i=0;i<20;i++)rows.push(article(`g${i}`,'Global '+i,`2026-08-27T${String(20-i).padStart(2,'0')}:00:00Z`,{feedKeys:['global']}));rows.push(article('safe','Safety', '2026-08-20T00:00:00Z',{feedKeys:['safety']}));
  assert(selectBalanced(rows,10).some(x=>x.id==='safe'));
});

test('refresh quality gate protects a healthy cache from partial updates', () => {
  assert.equal(refreshQualitySafe(8,4,180),false); assert.equal(refreshQualitySafe(130,7,180),true); assert.equal(refreshQualitySafe(40,3,0),false);
});

test('cache schema is enforced and strings are bounded safely', () => {
  const raw={schema:2,articles:[article('good1','Good')]}; assert.equal(normalizePayload(raw,'cache',{requireSchema:true}),null);
  raw.schema=3;raw.articles[0].title='😀'.repeat(700);const payload=normalizePayload(raw,'cache',{requireSchema:true});assert.equal([...payload.articles[0].title].length,600);assert(!payload.articles[0].title.includes('\uFFFD'));
});

test('API integer parser rejects invalid ranges', () => {
  assert.throws(()=>parseBoundedInt('abc',10,1,180,'limit'),e=>e.status===400);assert.throws(()=>parseBoundedInt('181',10,1,180,'limit'),e=>e.status===400);assert.equal(parseBoundedInt('25',10,1,180,'limit'),25);
});

test('gzip negotiation gives explicit gzip precedence over wildcard', () => {
  assert.equal(acceptsGzip('gzip;q=0, *;q=1'),false);assert.equal(acceptsGzip('*;q=0.5'),true);assert.equal(acceptsGzip('gzip;q=2'),false);assert.equal(acceptsGzip('br, gzip;q=0.5'),true);
});

test('generic-only category does not create fake related articles', () => {
  const target=article('aaaa','Completely different topic',undefined,{categories:['general']}),unrelated=article('bbbb','Another unrelated event',undefined,{categories:['general']});assert.equal(relatedArticles({articles:[target,unrelated]},target).length,0);
});

test('title normalization remains deterministic', () => assert.equal(normalizeTitle('  GPT—5: “Test”  '),'gpt 5 test'));

console.log(`\n${passed} regression tests passed.`);
