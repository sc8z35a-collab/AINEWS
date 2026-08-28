'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { refreshNews } = require('../server');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const distDir = path.join(root, 'dist');

async function main() {
  await fsp.rm(distDir, { recursive: true, force: true });
  await fsp.cp(publicDir, distDir, { recursive: true });
  const payload = await refreshNews({ force: true });
  const snapshot = { ...payload, delivery: 'static-snapshot', snapshotBuiltAt: new Date().toISOString() };
  await fsp.mkdir(path.join(distDir, 'data'), { recursive: true });
  await fsp.writeFile(path.join(distDir, 'data', 'news.json'), JSON.stringify(snapshot), 'utf8');
  await fsp.writeFile(path.join(distDir, '.nojekyll'), '', 'utf8');

  const assetFiles = ['common.js','home.js','company.js','trending.js','article.js','about.js','styles.css','manifest.webmanifest','sw.js'];
  const hash = crypto.createHash('sha256');
  for (const file of assetFiles) {
    const target = path.join(distDir, file);
    if (fs.existsSync(target)) hash.update(await fsp.readFile(target));
  }
  const version = `ainews-${hash.digest('hex').slice(0, 12)}`;
  const swPath = path.join(distDir, 'sw.js');
  const sw = (await fsp.readFile(swPath, 'utf8')).replace('__ASSET_VERSION__', version);
  await fsp.writeFile(swPath, sw, 'utf8');
  console.log(`GitHub Pages bundle created: ${snapshot.articles.length} articles, ${version}`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
