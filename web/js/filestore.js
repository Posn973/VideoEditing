// 歌詞動画・背景の「ファイルの場所」を覚えておく仕組み（Chrome・Edge の File System Access API）
// ブラウザはファイルのパス（C:\...）を知ることができないので、代わりに「ファイルハンドル」を
// このブラウザの中（IndexedDB）に保存しておき、区間ファイルの WebFileId と結びつける。
(function () {
  'use strict';

  const DB_NAME = 'VideoEditingWeb';
  const STORE = 'projects';
  const MAX_RECORDS = 300;          // 古い記録はこれを超えたら消す

  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const st = t.objectStore(STORE);
      let result;
      Promise.resolve(fn(st, r => { result = r; })).catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  async function put(id, rec) {
    rec.savedAt = Date.now();
    await tx('readwrite', st => { st.put(rec, id); });
    // 記録が増えすぎたら古いものから消す
    try {
      const all = await tx('readonly', (st, done) => {
        const items = [];
        const req = st.openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (c) { if (c.key !== '__outputDirs') items.push([c.key, c.value.savedAt || 0]); c.continue(); } else done(items);
        };
      });
      if (all && all.length > MAX_RECORDS) {
        all.sort((a, b) => a[1] - b[1]);
        const remove = all.slice(0, all.length - MAX_RECORDS).map(a => a[0]);
        await tx('readwrite', st => { for (const k of remove) st.delete(k); });
      }
    } catch { /* 片付けに失敗しても保存はできている */ }
  }

  function get(id) {
    return tx('readonly', (st, done) => {
      const req = st.get(id);
      req.onsuccess = () => done(req.result || null);
    });
  }

  const supported = () => 'showOpenFilePicker' in window && 'indexedDB' in window;

  function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  /** ファイルを見分けるための情報（名前・大きさ・更新日時） */
  const fileInfo = f => f ? { name: f.name, size: f.size, lastModified: f.lastModified } : null;
  const sameInfo = (a, b) => !!a && !!b && a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

  /** 読み取りの許可がもうあるか（'granted' / 'prompt' / 'denied'） */
  async function queryRead(handle) {
    try { return await handle.queryPermission({ mode: 'read' }); } catch { return 'prompt'; }
  }
  /** 読み取りの許可を求める（ボタンを押した直後に呼ぶこと） */
  async function requestRead(handle) {
    try { return await handle.requestPermission({ mode: 'read' }); } catch { return 'prompt'; }
  }

  /**
   * フォルダーの中から、名前が一致するファイルを探す（大文字・小文字は区別しない）。サブフォルダーも depth 段まで探す。
   * 戻り値：Map（小文字の名前 → { handle, path }）
   */
  async function findInDir(dir, names, depth = 2) {
    const want = new Set(names.filter(Boolean).map(n => n.toLowerCase()));
    const found = new Map();
    async function walk(d, path, level) {
      const subdirs = [];
      for await (const [name, h] of d.entries()) {
        if (h.kind === 'file') {
          const key = name.toLowerCase();
          if (want.has(key) && !found.has(key)) found.set(key, { handle: h, path: path + name });
        } else if (level < depth) subdirs.push([name, h]);
        if (found.size === want.size) return;
      }
      for (const [name, h] of subdirs) {
        if (found.size === want.size) return;
        try { await walk(h, path + name + '\\', level + 1); } catch { /* 開けないフォルダーは飛ばす */ }
      }
    }
    await walk(dir, dir.name + '\\', 0);
    return found;
  }

  // ---- 書き出し先のフォルダー（歌詞動画のフォルダー）を覚えておく ----
  const DIRS_KEY = '__outputDirs';
  const MAX_DIRS = 50;

  /** 歌詞動画（handle）がすぐ下に入っている、覚えておいたフォルダーを探す。なければ null */
  async function findDirOf(fileHandle) {
    let list = [];
    try { list = (await get(DIRS_KEY)) || []; } catch { }
    for (const d of list) {
      try {
        const path = await d.resolve(fileHandle);
        if (path && path.length === 1) return d;
      } catch { /* 消えたフォルダーなどは飛ばす */ }
    }
    return null;
  }
  /** フォルダーを覚える（同じフォルダーは 1 つだけ。新しいものを先頭に） */
  async function addDir(dir) {
    let list = [];
    try { list = (await get(DIRS_KEY)) || []; } catch { }
    const keep = [dir];
    for (const d of list) {
      let same = false;
      try { same = await d.isSameEntry(dir); } catch { }
      if (!same && keep.length < MAX_DIRS) keep.push(d);
    }
    await tx('readwrite', st => { st.put(keep, DIRS_KEY); });
  }
  /** fileHandle がフォルダー dir のすぐ下にあるか */
  async function isDirectChild(dir, fileHandle) {
    try { const p = await dir.resolve(fileHandle); return !!p && p.length === 1; } catch { return false; }
  }
  async function queryWrite(h) { try { return await h.queryPermission({ mode: 'readwrite' }); } catch { return 'prompt'; } }
  async function requestWrite(h) { try { return await h.requestPermission({ mode: 'readwrite' }); } catch { return 'prompt'; } }

  self.FileStore = {
    supported, put, get, newId, fileInfo, sameInfo, queryRead, requestRead, findInDir,
    findDirOf, addDir, isDirectChild, queryWrite, requestWrite,
  };
})();
