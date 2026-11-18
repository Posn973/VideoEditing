// 更新の確認と、新しい版への入れ替え
//
// ・アプリのファイルは、この端末の中（Cache Storage）に保存してあり、開くときはそこから読みます（sw.js）。
// ・更新の確認では、GitHub の version.json（ファイルごとのハッシュの一覧、1KB ほど）だけを読みます。
//     自動：アプリを開くたびに 1 回確認する（起動を遅くしないよう、2～5 秒たってから裏で確認する）。
//           ネットにつながっていなければ、何も出さずにやめる。
//     手動：「更新の確認」。続けて押したときのために、1 分だけ間をあける。
// ・version.json は、毎回ちがう印（?t=時刻）を付けずに読む。GitHub の配信の拠点（CDN）が約 10 分間
//   写しを持っているので、問い合わせはほとんど拠点で答えられ、GitHub 本体には届かない
//   （そのかわり、新しい版に気づくのが最大 10～20 分ほど遅れることがある）。
// ・新しい版があれば「今すぐ更新／後で更新」を出す。
//     今すぐ更新：変わったファイルだけを読み、ハッシュが合うことを確かめてから入れ替えて、開き直す。
//                 1 つでも合わなければ何も入れ替えず、今の版のまま使う。
//     後で更新：次に開いたとき、もう一度お知らせする（そのときはネットに問い合わせない）。
(function () {
  'use strict';
  const CACHE = 'videoediting-app';       // sw.js と同じ名前
  const MANIFEST_KEY = '__manifest__';
  const COOL_DOWN = 60 * 1000;            // 手動の確認を続けて押したとき、次に確認するまで（1 分）
  const LS_LAST = 've.update.lastCheck';
  const LS_PENDING = 've.update.pending';
  const LS_RESULT = 've.update.lastResult';   // 前の確認の結果（'latest' か、見つけた版）

  const base = new URL('./', location.href).href;
  const supported = 'serviceWorker' in navigator && 'caches' in self && isSecureContext && location.protocol !== 'file:';
  let hooks = { isBusy: () => false, confirmLeave: () => true, toast: m => alert(m) };
  let current = null;       // 今使っている版の version.json
  let busy = false;

  const $ = id => document.getElementById(id);
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { } };
  const fmtClock = ms => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

  async function sha256Hex(buf) {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function readCurrent() {
    try {
      const c = await caches.open(CACHE);
      const r = await c.match(MANIFEST_KEY);
      current = r ? JSON.parse(await r.text()) : null;
    } catch { current = null; }
    return current;
  }
  async function fetchManifest() {
    // 印を付けずに読む（配信の拠点の写しで答えてもらう）。ブラウザの一時保存の決まりもそのまま使う
    const r = await fetch(base + 'version.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    return { text, man: JSON.parse(text) };
  }
  const sameVersion = (a, b) => a && b && JSON.stringify(a.files) === JSON.stringify(b.files);

  function showVersion() {
    const v = current ? current.version : null;
    for (const id of ['lblVersion', 'aboutVersion']) {
      const n = $(id); if (!n) continue;
      n.textContent = !supported ? '（直接開いているため、更新の仕組みは使いません）'
        : v ? '版 ' + v : '（この端末への保存の準備中）';
    }
  }

  // ---- お知らせ（今すぐ更新／後で更新） ----
  function showBanner(version) {
    const b = $('updBanner');
    $('updText').textContent = `新しい版があります（版 ${version}）`;
    $('updNow').disabled = $('updLater').disabled = false;
    b.hidden = false;
  }
  function hideBanner() { $('updBanner').hidden = true; }

  /** 更新の確認。manual = 「更新の確認」を押したとき */
  async function check(manual) {
    if (!supported) { if (manual) hooks.toast('このページは直接開いているため、更新の確認は使えません（GitHub のページから開いたときに使えます）。', 6000); return; }
    if (busy) return;
    const now = Date.now();
    const last = +(lsGet(LS_LAST) || 0);
    if (manual && now - last < COOL_DOWN) {
      // 続けて押したとき：さきほどの結果を伝える
      const r = lsGet(LS_RESULT);
      if (r && r !== 'latest' && current && r !== current.version) showBanner(r);
      else hooks.toast('さきほど確認しました（いまの版が最新です）。新しい版を GitHub に上げた直後は、10 分ほどたってから確認してください。', 5000);
      return;
    }
    busy = true;
    try {
      if (!current) await readCurrent();
      const { man } = await fetchManifest();
      lsSet(LS_LAST, String(Date.now()));
      if (!current) { if (manual) hooks.toast('この端末への保存がまだ終わっていません。少し待ってから開き直してください。', 5000); return; }
      if (sameVersion(man, current)) {
        lsSet(LS_PENDING, null);
        lsSet(LS_RESULT, 'latest');
        hideBanner();
        if (manual) hooks.toast(`いまの版が最新です（版 ${current.version}）。`, 4000);
        return;
      }
      lsSet(LS_PENDING, man.version);
      lsSet(LS_RESULT, man.version);
      showBanner(man.version);
    } catch (e) {
      if (manual) hooks.toast('更新を確認できませんでした。インターネットにつながっているか確かめてください。', 5000);
      else console.warn('更新の確認に失敗しました:', e);
    } finally { busy = false; updateCheckButton(); }
  }

  /** man のファイルのうち、保存していない・中身が違うものを読む（ハッシュを確かめる）。同時に 4 つまで */
  async function downloadChanged(man, old, cache, onProgress) {
    const paths = Object.keys(man.files);
    const todo = [];
    for (const path of paths) {
      if (old.files[path] === man.files[path] && await cache.match(base + path)) continue;     // 変わっていないファイルは読まない
      todo.push(path);
    }
    const got = [];
    let done = 0, next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const path = todo[next++], hash = man.files[path];
        const r = await fetch(base + path + '?h=' + hash.slice(0, 12), { cache: 'no-store' });
        if (!r.ok) throw new Error(`${path} を読めませんでした（HTTP ${r.status}）`);
        const buf = await r.arrayBuffer();
        if (await sha256Hex(buf) !== hash) throw new Error(`${path} の中身が版の情報と合いません（配信の切り替わり中かもしれません）`);
        got.push([path, buf, r.headers.get('Content-Type') || '']);
        if (onProgress) onProgress(++done, todo.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return got;
  }
  /** そろったファイルを入れ替える（版の情報はいちばん最後に書く） */
  async function commit(cache, got, man, text, old) {
    for (const [path, buf, type] of got) await cache.put(base + path, new Response(buf, { headers: { 'Content-Type': type } }));
    for (const path of Object.keys(old.files)) if (!(path in man.files)) await cache.delete(base + path);
    await cache.put(MANIFEST_KEY, new Response(text, { headers: { 'Content-Type': 'application/json' } }));
  }
  /** はじめての保存が終わっていないとき（途中で通信が切れたときなど）に、ページの側で保存し直す */
  async function installMissing() {
    if (busy || current) return;
    busy = true;
    try {
      const { text, man } = await fetchManifest();
      const cache = await caches.open(CACHE);
      const got = await downloadChanged(man, { files: {} }, cache);
      await commit(cache, got, man, text, { files: {} });
      await readCurrent();
      if (!lsGet(LS_LAST)) lsSet(LS_LAST, String(Date.now()));
    } catch (e) { console.warn('この端末への保存に失敗しました（次に開いたときにもう一度試します）:', e); }
    finally { busy = false; showVersion(); }
  }

  /** 今すぐ更新：変わったファイルだけを読み、ハッシュを確かめてから入れ替える */
  async function updateNow() {
    if (busy) return;
    if (hooks.isBusy()) { alert('書き出し中は更新できません。書き出しが終わってから「今すぐ更新」を押してください。'); return; }
    if (!hooks.confirmLeave()) return;
    busy = true;
    $('updNow').disabled = $('updLater').disabled = true;
    const txt = $('updText');
    try {
      txt.textContent = '新しい版を読み込んでいます...';
      const { text, man } = await fetchManifest();
      const cache = await caches.open(CACHE);
      const old = current || { files: {} };
      const got = await downloadChanged(man, old, cache, (n, all) => { txt.textContent = `新しい版を読み込んでいます...（${n} / ${all}）`; });
      // ここまで来たら、変わったファイルがすべてそろっていて、ハッシュも合っている。入れ替える
      await commit(cache, got, man, text, old);
      lsSet(LS_PENDING, null);
      lsSet(LS_RESULT, 'latest');
      lsSet(LS_LAST, String(Date.now()));
      txt.textContent = `版 ${man.version} に更新しました。開き直します...`;
      window.__updating = true;          // 「ページを離れますか？」を出さない
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      txt.textContent = '更新できませんでした。今の版のまま使えます。時間をおいてもう一度お試しください。（' + e.message + '）';
      $('updLater').disabled = false;
      $('updLater').textContent = '閉じる';
      busy = false;
    }
  }

  function updateCheckButton() {
    const btn = $('btnCheckUpdate');
    if (!btn) return;
    const last = +(lsGet(LS_LAST) || 0);
    btn.title = !supported ? 'GitHub のページから開いたときに使えます'
      : '新しい版があるか確かめます' + (last ? `（前の確認：${fmtClock(last)}）` : '');
  }

  async function init(h) {
    hooks = Object.assign(hooks, h || {});
    $('updNow').addEventListener('click', updateNow);
    $('updLater').addEventListener('click', () => { if (!busy) { hideBanner(); $('updLater').textContent = '後で更新'; } });
    for (const id of ['btnCheckUpdate', 'aboutCheckUpdate']) {
      const n = $(id);
      if (n) n.addEventListener('click', e => { e.preventDefault(); check(true); });
    }
    updateCheckButton();
    setInterval(updateCheckButton, 60 * 1000);
    if (!supported) { showVersion(); return; }
    try {
      await navigator.serviceWorker.register('sw.js', { updateViaCache: 'all' });
    } catch (e) { console.warn('サービスワーカーを登録できませんでした:', e); }
    await readCurrent();
    if (!current) {
      // はじめて開いたとき：保存が終わるのを待って版を表示する
      // （サービスワーカーが保存する。15 秒たっても終わらなければ、ページの側で保存し直す）
      navigator.serviceWorker.ready.then(async () => {
        for (let k = 0; k < 15 && !current; k++) { await new Promise(r => setTimeout(r, 1000)); await readCurrent(); }
        if (!current && navigator.onLine !== false) await installMissing();
        showVersion();
        if (current && !lsGet(LS_LAST)) lsSet(LS_LAST, String(Date.now()));    // 保存したばかりなので、すぐには確認しない
      });
    }
    showVersion();
    // 「後で更新」にした版があれば、ネットに問い合わせずにもう一度お知らせする
    const pending = lsGet(LS_PENDING);
    if (pending && current && pending !== current.version) showBanner(pending);
    else if (pending && current && pending === current.version) lsSet(LS_PENDING, null);
    // 自動の確認：開くたびに 1 回、2～5 秒たってから裏で確認する
    if (current && navigator.onLine !== false) setTimeout(() => check(false), 2000 + Math.random() * 3000);
  }

  self.Updater = { init, check, get supported() { return supported; }, get version() { return current && current.version; } };
})();
