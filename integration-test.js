'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function freePort() { return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port))})}); }
async function waitFor(url, timeout=12000) { const until=Date.now()+timeout;let last;while(Date.now()<until){try{const r=await fetch(url);if(r.status<500)return r}catch(e){last=e}await new Promise(r=>setTimeout(r,100))}throw last||new Error('server readiness timeout'); }

(async()=>{
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'ainews-integration-'));
  const port=await freePort();
  const now=new Date().toISOString();
  const cache={schema:3,generatedAt:now,fetchedAt:now,mode:'live',degraded:false,sourceStats:[{key:'test',label:'Test',ok:true,count:1}],articles:[{id:'test-article',title:'OpenAI launches a test model',url:'https://example.com/article',sourceUrl:'https://example.com/',source:'Example',publishedAt:new Date(Date.now()-60000).toISOString(),summary:'Integration fixture',feedKeys:['openai'],feedLabels:['OpenAI'],locale:'en-US',origin:'live',sourceNames:['Example'],mentionCount:1}],trending:[]};
  await fsp.copyFile(path.join(__dirname,'data','fallback.json'),path.join(temp,'fallback.json'));
  await fsp.writeFile(path.join(temp,'cache.json'),JSON.stringify(cache),'utf8');
  const before=(await fsp.stat(path.join(temp,'cache.json'))).mtimeMs;
  const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:temp,DISABLE_NETWORK:'1',CACHE_TTL_MS:'600000',FORCE_IP_INTERVAL_MS:'10000',REFRESH_MIN_INTERVAL_MS:'10000'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',x=>{logs+=x});child.stderr.on('data',x=>{logs+=x});
  try{
    const base=`http://127.0.0.1:${port}`;
    const health=await waitFor(`${base}/api/health`);assert.equal(health.status,200);
    const response=await fetch(`${base}/api/news?limit=1`,{headers:{'accept-encoding':'gzip;q=0, *;q=1'}});assert.equal(response.status,200);assert.equal(response.headers.get('content-encoding'),null);assert(response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));assert(response.headers.get('x-request-id'));
    const news=await response.json();assert.equal(news.items.length,1);assert.equal(news.meta.refreshStatus,'none');
    const sideEffectFree=await (await fetch(`${base}/api/news?force=1&limit=1`)).json();assert.equal(sideEffectFree.meta.refreshStatus,'none');assert.equal(sideEffectFree.meta.generatedAt,now);
    const head=await fetch(`${base}/api/news?limit=1`,{method:'HEAD'});assert.equal(head.status,200);assert(Number(head.headers.get('content-length'))>0);
    const snapshotResponse=await fetch(`${base}/api/snapshot`);assert.equal(snapshotResponse.status,200);assert.equal(snapshotResponse.headers.get('cache-control'),'private, max-age=0, must-revalidate');assert.equal((await snapshotResponse.json()).articles.length,1);
    const servedWorker=await fetch(`${base}/sw.js`);assert.equal(servedWorker.headers.get('cache-control'),'no-cache');assert(!(await servedWorker.text()).includes('__ASSET_VERSION__'));
    const wrongMethod=await fetch(`${base}/api/refresh`);assert.equal(wrongMethod.status,405);assert.equal(wrongMethod.headers.get('allow'),'POST');
    const crossOrigin=await fetch(`${base}/api/refresh`,{method:'POST',headers:{origin:'https://evil.example'}});assert.equal(crossOrigin.status,403);
    const bodyRejected=await fetch(`${base}/api/refresh`,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:'{}'});assert.equal(bodyRejected.status,413);
    const refreshed=await fetch(`${base}/api/refresh`,{method:'POST',headers:{origin:base}});assert.equal(refreshed.status,200);const refreshBody=await refreshed.json();assert(['degraded','updated'].includes(refreshBody.meta.refreshStatus));
    const throttled=await fetch(`${base}/api/refresh`,{method:'POST',headers:{origin:base}});assert.equal(throttled.status,429);
    const after=(await fsp.stat(path.join(temp,'cache.json'))).mtimeMs;assert.equal(after,before,'fresh startup or failed partial refresh rewrote the healthy cache');
    console.log('✓ HTTP, security headers, side-effect-free GET, cache protection and throttling');
  }finally{
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);
    const resolved=path.resolve(temp),tmpRoot=path.resolve(os.tmpdir());
    if(resolved.startsWith(tmpRoot+path.sep)&&path.basename(resolved).startsWith('ainews-integration-'))await fsp.rm(resolved,{recursive:true,force:true});
  }
})().catch(err=>{console.error(err);process.exitCode=1});
