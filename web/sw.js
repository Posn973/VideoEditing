// 歌詞動画 透過合成（Web 版）のサービスワーカー
//
// アプリのファイルをこの端末の中（Cache Storage）に保存して、開くときはそこから読み込みます。
// インターネットにつながっていなくても起動できます。
//
// GitHub に問い合わせるのは、次のときだけです。
//   ・はじめて開いたとき（すべてのファイルを保存する）
//   ・更新の確認（version.json という小さなファイル 1 つだけを読む。印を付けないので、ほとんどは配信の拠点が答える）
//   ・新しい版に更新するとき（変わったファイルだけを読む。読み込みと入れ替えは js/updater.js が行う）
//
// version.json には、ファイルごとの SHA-256 ハッシュが書いてあります。
// ハッシュが合わないファイルは保存しません（途中で切れたファイルや、配信中の古いファイルを使わないため）。
'use strict';

const CACHE = 'videoediting-app';          // アプリのファイル（js/updater.js と同じ名前）
const MANIFEST_KEY = '__manifest__';        // 保存している版の version.json

const base = new URL('./', self.location).href;
const rel = url => url.startsWith(base) ? url.slice(base.length).split(/[?#]/)[0] : null;

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** はじめて入ったとき：version.json にあるファイルをすべて保存する */
async function installAll() {
  const cache = await caches.open(CACHE);
  if (await cache.match(MANIFEST_KEY)) return;           // すでに保存してある（入れ替えは updater.js が行う）
  const res = await fetch(base + 'version.json');
  if (!res.ok) throw new Error('version.json を読めませんでした');
  const text = await res.text();
  const man = JSON.parse(text);
  // 同時に読んで、全部そろってから保存する
  const got = await Promise.all(Object.entries(man.files).map(async ([path, hash]) => {
    const r = await fetch(base + path + '?h=' + hash.slice(0, 12), { cache: 'no-store' });
    if (!r.ok) throw new Error(path + ' を読めませんでした');
    const buf = await r.arrayBuffer();
    if (await sha256Hex(buf) !== hash) throw new Error(path + ' のハッシュが合いません');
    return [path, buf, r.headers.get('Content-Type') || ''];
  }));
  for (const [path, buf, type] of got) await cache.put(base + path, new Response(buf, { headers: { 'Content-Type': type } }));
  // 版の情報はいちばん最後に書く（途中で失敗したら、次に開いたときに最初からやり直す）
  await cache.put(MANIFEST_KEY, new Response(text, { headers: { 'Content-Type': 'application/json' } }));
}

self.addEventListener('install', e => {
  e.waitUntil(installAll().catch(err => console.warn('アプリの保存に失敗しました（ネットから読み込みます）:', err)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let path = rel(req.url);
  if (path === null) return;                         // ほかのサイト（GitHub の外）はそのまま
  if (path === 'version.json' || path === 'sw.js') return;   // 更新の確認はいつもネットへ
  if (req.cache === 'no-store') return;              // 新しい版の読み込み（updater.js）もネットへ
  if (path === '') path = 'index.html';
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(base + path);
    if (hit) return hit;
    return fetch(req);                               // まだ保存していないとき（はじめての起動の途中など）
  })());
});
