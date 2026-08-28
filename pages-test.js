'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=__dirname,publicDir=path.join(root,'public');
const pages=fs.readdirSync(publicDir).filter(x=>x.endsWith('.html'));
for(const page of pages){const html=fs.readFileSync(path.join(publicDir,page),'utf8');assert(html.includes('id="main-content"'),`${page} has no main target`);assert(html.includes('class="skip-link"'),`${page} has no skip link`);assert(html.includes('<noscript>'),`${page} has no noscript fallback`);assert(!/<script>(?!\s*<)/.test(html),`${page} contains an inline script`);assert(!html.includes('style='),`${page} contains inline styles`)}
const manifest=JSON.parse(fs.readFileSync(path.join(publicDir,'manifest.webmanifest'),'utf8'));assert.equal(manifest.start_url,'./index.html');assert.equal(manifest.scope,'./');assert.equal(manifest.icons.length,2);
for(const icon of manifest.icons){const data=fs.readFileSync(path.join(publicDir,icon.src));assert.equal(data.subarray(1,4).toString(),'PNG')}
const sw=fs.readFileSync(path.join(publicDir,'sw.js'),'utf8');assert(sw.includes('__ASSET_VERSION__'));assert(!sw.includes("'/index.html'"));assert(sw.includes("if(url.pathname.includes('/api/'))return"));assert(sw.includes("fetch(scopeUrl('./data/news.json'),{cache:'reload'})"));assert(sw.includes("headers.set('x-ainews-cache','offline')"));
assert(fs.readFileSync(path.join(publicDir,'common.js'),'utf8').includes('staticApi'));
const pagesWorkflow=fs.readFileSync(path.join(root,'.github','workflows','pages.yml'),'utf8');assert(pagesWorkflow.includes('actions/deploy-pages@v5'));assert(pagesWorkflow.includes('actions/upload-pages-artifact@v5'));
const built=spawnSync(process.execPath,['scripts/build-pages.js'],{cwd:root,env:{...process.env,DISABLE_NETWORK:'1'},encoding:'utf8'});if(built.status!==0)throw new Error(built.stderr||built.stdout||'Pages build failed');
assert(fs.existsSync(path.join(root,'dist','index.html')));const snapshot=JSON.parse(fs.readFileSync(path.join(root,'dist','data','news.json'),'utf8'));assert(snapshot.articles.length>0);assert(!fs.readFileSync(path.join(root,'dist','sw.js'),'utf8').includes('__ASSET_VERSION__'));
console.log(`✓ GitHub Pages bundle, PWA scope, icons and ${pages.length} accessible HTML pages`);
