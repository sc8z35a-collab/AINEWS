'use strict';

const VERSION='__ASSET_VERSION__';
const SHELL_CACHE=`${VERSION}-shell`;
const DATA_CACHE=`${VERSION}-data`;
const SHELL=['./','./index.html','./trending.html','./openai.html','./google.html','./anthropic.html','./company.html','./article.html','./about.html','./styles.css','./common.js','./home.js','./company.js','./trending.js','./article.js','./about.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
const scopeUrl=path=>new URL(path,self.registration.scope).href;

async function installCaches(){const shell=await caches.open(SHELL_CACHE);await shell.addAll(SHELL.map(scopeUrl));try{const response=await fetch(scopeUrl('./data/news.json'),{cache:'reload'});if(response.ok){const data=await caches.open(DATA_CACHE);await data.put(scopeUrl('./data/news.json'),response)}}catch{}await self.skipWaiting()}
self.addEventListener('install',event=>event.waitUntil(installCaches()));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==SHELL_CACHE&&k!==DATA_CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));

async function navigationResponse(request){try{const fresh=await fetch(request);if(!fresh.ok)throw new Error(`HTTP ${fresh.status}`);const cache=await caches.open(SHELL_CACHE);await cache.put(new Request(new URL(request.url).origin+new URL(request.url).pathname),fresh.clone());return fresh}catch{const url=new URL(request.url);const normalized=new Request(url.origin+url.pathname);return await caches.match(normalized)||await caches.match(scopeUrl('./index.html'))||Response.error()}}
function markOffline(cached){if(!cached)return Response.error();const headers=new Headers(cached.headers);headers.set('x-ainews-cache','offline');return new Response(cached.body,{status:cached.status,statusText:cached.statusText,headers})}
async function snapshotResponse(request){const cache=await caches.open(DATA_CACHE);try{const fresh=await fetch(request);if(!fresh.ok)throw new Error(`HTTP ${fresh.status}`);await cache.put(scopeUrl('./data/news.json'),fresh.clone());return fresh}catch{return markOffline(await cache.match(scopeUrl('./data/news.json')))}}
async function apiSnapshotResponse(request){const cache=await caches.open(DATA_CACHE),key=scopeUrl('./api/snapshot');try{const fresh=await fetch(request);if(!fresh.ok)throw new Error(`HTTP ${fresh.status}`);await cache.put(key,fresh.clone());return fresh}catch{return markOffline(await cache.match(key))}}
async function assetResponse(request){const normalized=new Request(new URL(request.url).origin+new URL(request.url).pathname);const cached=await caches.match(normalized);if(cached)return cached;const fresh=await fetch(request);if(fresh.ok){const cache=await caches.open(SHELL_CACHE);await cache.put(normalized,fresh.clone())}return fresh}

self.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);if(url.origin!==location.origin)return;if(url.pathname.endsWith('/data/news.json')){event.respondWith(snapshotResponse(request));return}if(url.pathname.endsWith('/api/snapshot')){event.respondWith(apiSnapshotResponse(request));return}if(url.pathname.includes('/api/'))return;if(request.mode==='navigate'){event.respondWith(navigationResponse(request));return}event.respondWith(assetResponse(request))});
