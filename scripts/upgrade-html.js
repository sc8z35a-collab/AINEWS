'use strict';

const fs = require('fs');
const path = require('path');
const publicDir = path.join(__dirname, '..', 'public');
for (const name of fs.readdirSync(publicDir).filter(x => x.endsWith('.html'))) {
  const file = path.join(publicDir, name);
  let html = fs.readFileSync(file, 'utf8');
  if (!html.includes('rel="manifest"')) html = html.replace('<link rel="stylesheet"', '<link rel="manifest" href="manifest.webmanifest"><link rel="stylesheet"');
  if (!html.includes('rel="icon"')) html = html.replace('<link rel="stylesheet"', '<link rel="icon" href="icons/icon-192.png"><link rel="stylesheet"');
  const accessIntro = '<a class="skip-link" href="#main-content">本文へ移動</a><noscript><div class="noscript">このサイトのニュース表示にはJavaScriptが必要です。</div></noscript>';
  while (html.includes(accessIntro + accessIntro)) html = html.replace(accessIntro + accessIntro, accessIntro);
  if (!html.includes('class="skip-link"')) html = html.replace('<body>', `<body>${accessIntro}`);
  html = html.replace('<main>', '<main id="main-content" tabindex="-1">');
  html = html.replace(/<button id="menuBtn" class="menu-btn"(?: type="button")? aria-expanded="false"(?: aria-label="メニュー")?>/g, '<button id="menuBtn" class="menu-btn" type="button" aria-expanded="false" aria-label="メニュー">');
  html = html.replace(/<button id="refreshBtn" class="refresh-btn">/g, '<button id="refreshBtn" class="refresh-btn" type="button">');
  html = html.replace(/id="resultCount" class="countbox"(?: role="status"| aria-live="polite"| aria-atomic="true")*/g, 'id="resultCount" class="countbox" role="status" aria-live="polite" aria-atomic="true"');
  html = html.replace(/id="newsGrid" class="news-grid"(?: aria-live="polite")*/g, 'id="newsGrid" class="news-grid" aria-live="polite"');
  html = html.replace(/<script>if\('serviceWorker'[\s\S]*?<\/script>/g, '');
  html = html.replace(/<script>api\('\/api\/news\?limit=1'\)[\s\S]*?<\/script>/g, '<script src="about.js"></script>');
  html = html.replace('href="trending.html" style="text-decoration:none"', 'href="trending.html" class="unstyled-link"');
  html = html.replace('<strong style="color:var(--ink)">AI BRIEF Ultra</strong>', '<strong class="footer-brand">AI BRIEF Ultra</strong>');
  html = html.replace('<div style="padding:24px">読込中…</div>', '<div class="loading-pad">読込中…</div>');
  fs.writeFileSync(file, html, 'utf8');
}
