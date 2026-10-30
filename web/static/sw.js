// The service worker: keeps the whole site in the browser so that it opens
// and plays without the network (and, installed from the browser's menu, as
// an app on a phone: manifest.webmanifest). The server fills in VERSION, a
// hash of the static files, and FILES, their paths, when it serves this file
// (main.rs: sw), so a deploy that changes anything is a new version: the
// browser installs it on the next visit, it fetches every file afresh into
// a cache of its own, and the page (app.js: updates) lets it take over and
// reloads once nothing is being played.
//
// Requests: static files come from the cache (the analysis's network is
// asked for by version, /nets/value.bin?3, and kept by path); a page's
// address is the app's one page; the API is asked over the network, and its
// answers to GET kept for when there is none, so that the player stays
// logged in, the daily challenges last seen still show, and a game's copy
// on the server is what it was. Logging in or out drops those answers.
const VERSION = '__VERSION__';
const FILES = __FILES__;
const SHELL = `shell-${VERSION}`;
const API = 'api';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', e => {
  if (e.data === 'skip') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    if (e.request.method === 'GET') e.respondWith(networkFirst(e.request));
    else if (/^\/api\/(login|signup|logout)$/.test(url.pathname)) e.respondWith(fetch(e.request).then(res => { if (res.ok) caches.delete(API); return res; }));
    return;
  }
  if (e.request.method !== 'GET') return;
  const file = FILES.includes(url.pathname) ? url.pathname : e.request.mode === 'navigate' ? '/index.html' : null;
  e.respondWith(file ? caches.match(file).then(res => res || fetch(e.request)) : fetch(e.request));
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(API)).put(req, res.clone());
    return res;
  } catch (err) {
    const kept = await caches.match(req);
    return kept || new Response(JSON.stringify({ error: 'You are offline' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
}
