// 画面の動き（Windows 版 Form1.cs にあたる部分）
(function () {
  'use strict';
  const MB = self.Mediabunny;
  const { OutlineColorMode, defaultSettings } = self.CompositorLib;
  const { SegmentTimeline, contains, cloneSettings, saveProject, loadProject } = self.Segments;
  const { MediaFile, SequentialReader, sampleToRgba, frameForWorker, isImageFile, fmtDuration } = self.Media;

  const $ = id => document.getElementById(id);
  const el = {};
  for (const id of ['txtLyric', 'btnLyric', 'lblLyricInfo', 'rbBgImage', 'rbBgVideo', 'txtBg', 'btnBg', 'lblBgInfo',
    'trkKey', 'nudKey', 'trkOutline', 'nudOutline', 'trkNoise', 'nudNoise', 'cmbColor', 'colCustom', 'btnReset', 'btnSetBase',
    'cmbQuality', 'txtOut', 'btnExport', 'btnCancel', 'progress', 'lblStatus', 'lblEnv', 'lnkAbout',
    'preview', 'previewMsg', 'previewHost', 'trkTime', 'segBar', 'btnMarkStart', 'btnMarkEnd', 'btnAddSeg', 'btnEditSeg',
    'btnDelSeg', 'btnSaveSeg', 'btnLoadSeg', 'lblSegInfo', 'btnBackSec', 'btnBackFrame', 'btnPlay', 'btnFwdFrame', 'btnFwdSec',
    'lblTime', 'chkSound', 'trkVolume', 'lblVolume', 'cmbPlaySize', 'rbViewComposite', 'rbViewLyric', 'rbViewBg', 'btnFull',
    'lblPlayInfo', 'grpLyric', 'grpBg', 'fileLyric', 'fileBg', 'fileSeg', 'ctxMenu', 'aboutDialog', 'aboutClose',
    'chkOutSameDir', 'chkGpu', 'segDialog', 'segDlgTitle', 'sdStart', 'sdEnd', 'sdStartLbl', 'sdEndLbl', 'sdNowStart', 'sdNowEnd', 'sdNudKey', 'sdTrkKey',
    'sdNudOutline', 'sdTrkOutline', 'sdNudNoise', 'sdTrkNoise', 'sdColor', 'sdCustom', 'sdCopy', 'sdOk', 'sdCancel'])
    el[id] = $(id);

  // ------------------------------------------------------------------
  // 状態
  // ------------------------------------------------------------------
  const cores = navigator.hardwareConcurrency || 4;
  const pool = new CompositorPool(Math.max(1, Math.min(12, cores - 1)));
  const PLAY_WORKERS = Math.min(8, pool.size);      // 再生中に同時に合成するスレッドの数
  const EXPORT_WORKERS = Math.min(8, pool.size);    // 1 つで 1080p なら約 100MB 使うので、多くしすぎない

  let lyric = null, bg = null;            // MediaFile
  let curTime = 0;                        // 今表示している位置（秒）
  let customColor = [255, 255, 255];
  const segments = [];
  let selectedSeg = null;
  let segmentsDirty = false;
  let markStart = null, markEnd = null;
  let timeline = new SegmentTimeline([], defaultSettings());
  let viewMode = 0;                       // 0 合成結果 / 1 元の歌詞動画 / 2 背景
  let player = null;
  let exporting = false;
  let exportAbort = null;

  // ------------------------------------------------------------------
  // 保存しておく設定（このブラウザの中だけに保存）
  // ------------------------------------------------------------------
  const STORE_KEY = 'VideoEditingWeb.settings';
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
  }
  const prefs = loadPrefs();
  function savePrefs() {
    Object.assign(prefs, {
      KeyThreshold: +el.trkKey.value, OutlineRadius: +el.trkOutline.value, NoiseSize: +el.trkNoise.value,
      OutlineMode: +el.cmbColor.value, CustomColor: customColor, QualityIndex: +el.cmbQuality.value,
      BackgroundIsVideo: el.rbBgVideo.checked, PlayQuality: +el.cmbPlaySize.value,
      PlaySound: el.chkSound.checked, Volume: +el.trkVolume.value, OutSameDir: el.chkOutSameDir.checked, UseGpu: el.chkGpu.checked,
    });
    try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch { }
  }

  // ------------------------------------------------------------------
  // ちょっとした部品
  // ------------------------------------------------------------------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  const fromHex = h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16));

  function fmtTime(sec) {     // 0:00.0
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60), s = sec - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }
  function fmtSeg(sec) {      // 0:00.00（区間の表示）
    const all = Math.round(Math.max(0, sec) * 100);      // 0.01 秒単位に四捨五入
    const m = Math.floor(all / 6000), s = Math.floor(all / 100) % 60, cs = all % 100;
    return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  let toastTimer = 0;
  function toast(msg, ms = 4000) {
    let t = $('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  /** スライダーと数値欄をつなぐ */
  function linkSlider(trk, nud, onChange) {
    trk.addEventListener('input', () => { nud.value = trk.value; onChange(); });
    nud.addEventListener('change', () => {
      const v = clamp(Math.round(+nud.value || 0), +trk.min, +trk.max);
      nud.value = v; trk.value = v; onChange();
    });
  }

  // ------------------------------------------------------------------
  // ③ 調整
  // ------------------------------------------------------------------
  function currentSettings() {
    return {
      KeyThreshold: +el.trkKey.value, KeySoftness: 33, OutlineRadius: +el.trkOutline.value, NoiseSize: +el.trkNoise.value,
      OutlineMode: +el.cmbColor.value, CustomR: customColor[0], CustomG: customColor[1], CustomB: customColor[2],
    };
  }

  function applyGlobalSettings(g) {
    setSlider(el.trkKey, el.nudKey, Math.round(g.KeyThreshold));
    setSlider(el.trkOutline, el.nudOutline, Math.round(g.OutlineRadius));
    setSlider(el.trkNoise, el.nudNoise, Math.round(g.NoiseSize));
    customColor = [g.CustomR, g.CustomG, g.CustomB];
    el.colCustom.value = hex(customColor);
    el.cmbColor.value = String(clamp(g.OutlineMode | 0, 0, 4));
    onAdjustChanged();
  }
  function setSlider(trk, nud, v) { v = clamp(v, +trk.min, +trk.max); trk.value = v; nud.value = v; }

  function onAdjustChanged() {
    if (typeof updateSummaries === 'function') updateSummaries();
    rebuildTimeline();
    updateSegInfo();
    requestComposite();
    savePrefsSoon();
  }
  let savePrefsTimer = 0;
  function savePrefsSoon() { clearTimeout(savePrefsTimer); savePrefsTimer = setTimeout(savePrefs, 500); }

  linkSlider(el.trkKey, el.nudKey, onAdjustChanged);
  linkSlider(el.trkOutline, el.nudOutline, onAdjustChanged);
  linkSlider(el.trkNoise, el.nudNoise, onAdjustChanged);
  el.cmbColor.addEventListener('change', onAdjustChanged);
  el.colCustom.addEventListener('input', () => {
    customColor = fromHex(el.colCustom.value);
    if (el.cmbColor.value !== '4') el.cmbColor.value = '4';
    onAdjustChanged();
  });

  const BASE_KEY = 'VideoEditingWeb.base';
  function loadBase() { try { return JSON.parse(localStorage.getItem(BASE_KEY) || 'null'); } catch { return null; } }
  function updateBaseTooltip() {
    const b = loadBase();
    el.btnReset.title = b
      ? `保存した基準値に戻します（抜き具合 ${b.KeyThreshold}・縁取り ${b.OutlineRadius}・粒 ${b.NoiseSize}）`
      : 'アプリの初期値に戻します（抜き具合 83・縁取り 4・粒 0・自動の色）';
  }
  el.btnReset.addEventListener('click', () => {
    const b = loadBase();
    setSlider(el.trkKey, el.nudKey, b ? b.KeyThreshold : 83);
    setSlider(el.trkOutline, el.nudOutline, b ? b.OutlineRadius : 4);
    setSlider(el.trkNoise, el.nudNoise, b ? b.NoiseSize : 0);
    if (b && b.CustomColor) { customColor = b.CustomColor; el.colCustom.value = hex(customColor); }
    el.cmbColor.value = String(b ? b.OutlineMode : 0);
    onAdjustChanged();
  });
  el.btnSetBase.addEventListener('click', () => {
    const color = el.cmbColor.value === '4' ? `指定した色（R${customColor[0]} G${customColor[1]} B${customColor[2]}）` : el.cmbColor.selectedOptions[0].text;
    if (!confirm(`今の値を基準値として保存します。\n\n背景の抜き具合：${el.trkKey.value}\n縁取りの太さ：${el.trkOutline.value}\n粒ノイズを消す：${el.trkNoise.value}\n縁取りの色：${color}\n\n「調整を初期値に戻す」を押すと、この値に戻ります。ブラウザを閉じても残ります。`)) return;
    try {
      localStorage.setItem(BASE_KEY, JSON.stringify({
        KeyThreshold: +el.trkKey.value, OutlineRadius: +el.trkOutline.value, NoiseSize: +el.trkNoise.value,
        OutlineMode: +el.cmbColor.value, CustomColor: customColor,
      }));
    } catch { }
    updateBaseTooltip();
  });

  // ------------------------------------------------------------------
  // ① ② ファイルの登録
  // ------------------------------------------------------------------
  // 「参照...」：Chrome・Edge ではファイルの場所も受け取れる選び方を使う（区間ファイルに場所を覚えるため）
  const VIDEO_TYPES = [{ description: '動画', accept: { 'video/*': ['.mp4', '.mov', '.m4v', '.mkv', '.webm'] } }];
  const IMAGE_TYPES = [{ description: '画像', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp', '.avif'] } }];
  /** ファイルを 1 つ選ぶ。選べたら { file, handle }、やめたら null、この方法が使えないときは undefined */
  async function pickFile(id, types) {
    if (!FileStore.supported()) return undefined;
    try {
      const [h] = await window.showOpenFilePicker({ id, types, multiple: false });
      return { file: await h.getFile(), handle: h };
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      return undefined;
    }
  }
  el.btnLyric.addEventListener('click', async () => {
    const r = await pickFile('lyric', VIDEO_TYPES);
    if (r === undefined) el.fileLyric.click();
    else if (r) loadLyric(r.file, r.handle);
  });
  el.btnBg.addEventListener('click', async () => {
    const r = await pickFile('background', el.rbBgVideo.checked ? VIDEO_TYPES : IMAGE_TYPES);
    if (r === undefined) {
      el.fileBg.accept = el.rbBgVideo.checked ? 'video/*,.mp4,.mov,.m4v,.mkv,.webm' : 'image/*';
      el.fileBg.click();
    } else if (r) loadBackground(r.file, r.handle);
  });
  el.fileLyric.addEventListener('change', () => { const f = el.fileLyric.files[0]; el.fileLyric.value = ''; if (f) loadLyric(f); });
  el.fileBg.addEventListener('change', () => { const f = el.fileBg.files[0]; el.fileBg.value = ''; if (f) loadBackground(f); });

  let lyricHandle = null, bgHandle = null;     // 選んだファイルの場所（分からないときは null）
  let projectId = '';                          // 今の区間と結びついている WebFileId

  /** 歌詞動画を登録する。読み込めたら true */
  async function loadLyric(file, handle = null) {
    if (exporting) return false;
    if (isImageFile(file)) { alert('歌詞動画には動画ファイルを選んでください。'); return false; }
    if (!confirmDiscardSegments()) return false;
    stopPlayback(false);
    el.lblLyricInfo.textContent = '読み込んでいます...';
    let m;
    try { m = await MediaFile.open(file); }
    catch (e) {
      el.lblLyricInfo.textContent = lyric ? lyric.infoText() : '';
      alert('歌詞動画を読み込めませんでした。\n' + e.message);
      return false;
    }
    if (lyric) lyric.dispose();
    lyric = m;
    lyricHandle = handle;
    projectId = '';
    closeStillReaders();
    el.txtLyric.value = file.name;
    el.txtLyric.title = file.name;
    el.lblLyricInfo.textContent = m.infoText();
    const base = file.name.replace(/\.[^.]+$/, '');
    if (!el.txtOut.dataset.edited) el.txtOut.value = base + '_合成.mp4';
    updateLayout();
    updateSummaries();
    // 区間は歌詞動画ごとのものなので、別の動画にしたら消す
    segments.length = 0; selectedSeg = null; markStart = markEnd = null; segmentsDirty = false;
    closeSegDialog(false);
    rebuildTimeline();
    el.trkTime.max = Math.max(0, lastFrameTime());
    curTime = 0;
    refreshSegmentUi();
    updateTime();
    updateButtons();
    requestPreview(true);
    return true;
  }

  /** 背景を登録する。読み込めたら true */
  async function loadBackground(file, handle = null) {
    if (exporting) return false;
    const image = isImageFile(file);
    stopPlayback(false);
    el.lblBgInfo.textContent = '読み込んでいます...';
    let m;
    try { m = await MediaFile.open(file); }
    catch (e) {
      el.lblBgInfo.textContent = bg ? bg.infoText() : '';
      alert('背景を読み込めませんでした。\n' + e.message);
      return false;
    }
    if (bg) bg.dispose();
    bg = m;
    bgHandle = handle;
    bgStillCache = null;
    closeStillReaders();
    // 選んだファイルに合わせて「画像／動画」を切り替える
    if (image) el.rbBgImage.checked = true; else el.rbBgVideo.checked = true;
    el.txtBg.value = file.name;
    el.txtBg.title = file.name;
    updateBackgroundNote();
    updateSummaries();
    savePrefsSoon();
    updateButtons();
    requestPreview(true);
    return true;
  }

  function updateBackgroundNote() {
    if (!bg) { el.lblBgInfo.textContent = ''; return; }
    let s = bg.infoText();
    if (lyric && bg.width * lyric.height !== bg.height * lyric.width)
      s += '\n縦横の比率が歌詞動画と違うため、はみ出す部分を切り取って全体に合わせます。';
    if (lyric && !bg.isImage && bg.duration + 0.05 < lyric.duration)
      s += '\n歌詞動画より短いので、繰り返して使います。';
    el.lblBgInfo.textContent = s;
    el.lblBgInfo.style.whiteSpace = 'pre-line';
  }

  for (const rb of [el.rbBgImage, el.rbBgVideo]) rb.addEventListener('change', () => {
    // 種類を変えたら、今の背景が合わないときは外す
    if (bg && (bg.isImage !== el.rbBgImage.checked)) {
      bg.dispose(); bg = null; bgHandle = null; bgStillCache = null;
      el.txtBg.value = ''; el.lblBgInfo.textContent = '';
      updateButtons(); requestPreview(false);
    }
    savePrefsSoon();
  });

  // ドラッグ＆ドロップ
  function setupDrop(target, onFiles) {
    target.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); target.classList.add('drop'); });
    target.addEventListener('dragleave', () => target.classList.remove('drop'));
    target.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation(); target.classList.remove('drop');
      const files = [...(e.dataTransfer.files || [])];
      if (!files.length || exporting) return;
      // ファイルの場所（ハンドル）は、落とした瞬間に頼まないと受け取れない
      const items = [...e.dataTransfer.items].filter(i => i.kind === 'file');
      const hp = items.map(i => i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null));
      Promise.all(hp).then(hs => {
        const handles = files.map((f, k) => (hs[k] && hs[k].kind === 'file' && hs[k].name === f.name) ? hs[k] : null);
        onFiles(files, handles);
      });
    });
  }
  setupDrop(el.grpLyric, (files, hs) => loadLyric(files[0], hs[0]));
  setupDrop(el.grpBg, (files, hs) => loadBackground(files[0], hs[0]));
  setupDrop(document.body, (files, hs) => dropElsewhere(files, hs));

  async function dropElsewhere(files, handles = []) {
    const json = files.find(f => /\.json$/i.test(f.name));
    if (json) { await loadSegmentsFromFiles(files, handles); return; }
    const f = files[0], h = handles[0] || null;
    if (isImageFile(f)) { loadBackground(f, h); return; }
    // 動画：歌詞動画がまだなら歌詞動画、あれば聞く
    if (!lyric) { loadLyric(f, h); return; }
    showMenuAt(lastPointer.x, lastPointer.y, [
      { text: `「${f.name}」をどちらに使いますか？`, disabled: true }, { sep: true },
      { text: '① 歌詞動画にする', action: () => loadLyric(f, h) },
      { text: '② 背景動画にする', action: () => loadBackground(f, h) },
    ]);
  }
  const lastPointer = { x: 200, y: 200 };
  document.addEventListener('dragover', e => { lastPointer.x = e.clientX; lastPointer.y = e.clientY; });

  // ------------------------------------------------------------------
  // 時間・コマ
  // ------------------------------------------------------------------
  const fps = () => (lyric && lyric.fps > 0 ? lyric.fps : 30);
  const lastFrameIndex = () => lyric ? Math.max(0, lyric.frameCount - 1) : 0;
  const lastFrameTime = () => lastFrameIndex() / fps();
  const frameIndexOf = t => Math.round(t * fps());

  function updateTime() {
    if (!lyric) { el.lblTime.textContent = '0:00.0 / 0:00'; return; }
    el.lblTime.textContent = `${fmtTime(curTime)} / ${fmtDuration(lyric.duration)}　（${frameIndexOf(curTime) + 1} コマ目）`;
    if (!draggingTime) el.trkTime.value = curTime;
    drawSegBar();
  }

  let draggingTime = false;
  el.trkTime.addEventListener('pointerdown', () => { draggingTime = true; if (player) stopPlayback(false); });
  el.trkTime.addEventListener('pointerup', () => { draggingTime = false; });
  el.trkTime.addEventListener('input', () => {
    if (!lyric) return;
    if (player) stopPlayback(false);
    curTime = clamp(+el.trkTime.value, 0, lastFrameTime());
    updateTime();
    updateSegInfo();
    requestPreview(true, 40);
  });

  function seekTo(t) {
    if (!lyric) return;
    if (player) stopPlayback(false);
    curTime = clamp(frameIndexOf(t), 0, lastFrameIndex()) / fps();
    updateTime();
    updateSegInfo();
    requestPreview(true, 30);
  }

  function stepFrames(delta) {
    if (!lyric || exporting) return Promise.resolve();
    if (player) stopPlayback(false);
    const k = clamp(frameIndexOf(curTime) + delta, 0, lastFrameIndex());
    curTime = k / fps();
    updateTime();
    updateSegInfo();
    return requestPreview(true, 0);
  }
  function stepSeconds(sec) { return stepFrames(Math.round(sec * fps())); }

  // 押し続けると連続で進む・戻るボタン
  function setupStepButton(btn, action, repeat) {
    let held = false;
    btn.addEventListener('pointerdown', async e => {
      if (e.button !== 0 || btn.disabled) return;
      held = true;
      btn.setPointerCapture(e.pointerId);
      await action();
      if (!repeat) return;
      await sleep(350);
      while (held) await Promise.all([action(), sleep(30)]);
    });
    const up = () => { held = false; };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
  }
  setupStepButton(el.btnBackSec, () => stepSeconds(-1), false);
  setupStepButton(el.btnFwdSec, () => stepSeconds(1), false);
  setupStepButton(el.btnBackFrame, () => stepFrames(-1), true);
  setupStepButton(el.btnFwdFrame, () => stepFrames(1), true);
  // 全画面（区間の設定を開いたまま）の操作ボタン：下のボタンと同じ動き
  setupStepButton($('fbBackSec'), () => stepSeconds(-1), false);
  setupStepButton($('fbFwdSec'), () => stepSeconds(1), false);
  setupStepButton($('fbBackFrame'), () => stepFrames(-1), true);
  setupStepButton($('fbFwdFrame'), () => stepFrames(1), true);
  $('fbPlay').addEventListener('click', () => el.btnPlay.click());
  $('fbExit').addEventListener('click', () => { if (document.body.classList.contains('full')) toggleFullScreen(); });
  for (const b of $('fullBar').querySelectorAll('button')) b.addEventListener('dblclick', e => e.stopPropagation());
  {
    // 再生ボタンの表示（▶ 再生／■ 停止）と使える・使えないを、下のボタンに合わせる
    const fb = $('fbPlay'), sync = () => { fb.innerHTML = el.btnPlay.innerHTML; fb.disabled = el.btnPlay.disabled; };
    new MutationObserver(sync).observe(el.btnPlay, { attributes: true, childList: true, characterData: true, subtree: true });
    sync();
    const steps = [['btnBackSec', 'fbBackSec'], ['btnBackFrame', 'fbBackFrame'], ['btnFwdFrame', 'fbFwdFrame'], ['btnFwdSec', 'fbFwdSec']];
    for (const [src, dst] of steps) {
      const f = () => { $(dst).disabled = el[src].disabled; };
      new MutationObserver(f).observe(el[src], { attributes: true, attributeFilter: ['disabled'] });
      f();
    }
  }

  // ボタンを長押ししたとき、文字の選択やコピーのメニューを出さない（押し続けで進む・戻るため）
  document.addEventListener('contextmenu', e => { if (e.target.closest && e.target.closest('button')) e.preventDefault(); });
  document.addEventListener('keydown', onKeyDown);
  function onKeyDown(e) {
    if (e.target.closest && e.target.closest('input[type=text], input[type=number], select')) return;
    if (e.key === 'F11') { e.preventDefault(); toggleFullScreen(); return; }
    if (e.key === 'F1') { e.preventDefault(); openHelp(); return; }
    if (e.key === 'Escape' && document.body.classList.contains('full')) { toggleFullScreen(); return; }
    if (!lyric || exporting) return;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const sign = e.key === 'ArrowLeft' ? -1 : 1;
      if (keyBusy) return;          // 前のコマの表示が終わるまで次は待つ（押しっぱなしでたまらないように）
      keyBusy = true;
      (e.shiftKey ? stepSeconds(sign) : stepFrames(sign)).finally(() => { keyBusy = false; });
    } else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      el.btnPlay.click();
    }
  }
  let keyBusy = false;

  // ------------------------------------------------------------------
  // プレビュー（止まっているとき：元のサイズで合成）
  // ------------------------------------------------------------------
  const ctxPreview = el.preview.getContext('2d');
  let lyricStill = null;         // { idx, w, h, data }  今の位置の歌詞動画のコマ
  let bgStill = null;            // { key, data }        今の位置の背景
  let bgStillCache = null;       // 背景画像（大きさごと）
  let stillReader = null, bgReader = null;
  let previewGen = 0;
  let compositeBusy = false, compositePending = false, compositeDone = Promise.resolve();

  const frameCache = new Map();
  function closeStillReaders() {
    frameCache.clear();
    if (stillReader) { stillReader.close(); stillReader = null; }
    if (bgReader) { bgReader.close(); bgReader = null; }
    lyricStill = null; bgStill = null;
  }

  function outSize() { return lyric ? [lyric.width & ~1 || 2, lyric.height & ~1 || 2] : [2, 2]; }

  /** 歌詞動画の t 秒のコマを、続けて読むのが速いときは続きから、そうでなければ探して読む */
  async function lyricFrameAt(t) {
    const tol = 0.25 / fps();
    if (stillReader) {
      const last = stillReader.lastT;
      if (!(t >= last - 1e-6 && t - last < 3)) { stillReader.close(); stillReader = null; }
    }
    if (!stillReader) stillReader = new SequentialReader(lyric, Math.max(0, t), false);
    stillReader.lastT = t;
    return stillReader.frameAt(t + tol);
  }
  async function bgFrameAt(t) {
    if (bgReader) {
      const last = bgReader.lastT;
      if (!(t >= last - 1e-6 && t - last < 3)) { bgReader.close(); bgReader = null; }
    }
    if (!bgReader) bgReader = new SequentialReader(bg, Math.max(0, t), true);
    bgReader.lastT = t;
    return bgReader.frameAt(t + 1e-4);
  }

  function bgImageRgba(w, h) {
    if (!bgStillCache || bgStillCache.w !== w || bgStillCache.h !== h) bgStillCache = { w, h, data: bg.imageRgba(w, h) };
    return bgStillCache.data;
  }

  const delayTimers = [];
  /** 今の位置のコマを読み直して表示する。連続した操作は最後の 1 回だけ実行 */
  function requestPreview(reload, delayMs = 0) {
    const gen = ++previewGen;
    return new Promise(resolve => {
      const run = async () => {
        if (gen !== previewGen) return resolve();
        try { await loadStill(gen); } catch (e) { showMsg('プレビューを作れませんでした：' + e.message); }
        resolve();
      };
      if (delayMs > 0) setTimeout(run, delayMs); else run();
    });
  }

  async function loadStill(gen) {
    if (!lyric) { showMsg('① 歌詞動画 と ② 背景 を選ぶと、ここにプレビューが表示されます'); return; }
    if (player) return;
    const [w, h] = outSize();
    const idx = frameIndexOf(curTime);
    const t = idx / fps();
    if (!lyricStill || lyricStill.idx !== idx || lyricStill.w !== w) {
      const cached = frameCache.get(`${idx}:${w}x${h}`);
      if (cached) lyricStill = cached;
      else {
        const s = await lyricFrameAt(t);
        if (gen !== previewGen) return;
        if (!s) { showMsg('この位置のコマを読み込めませんでした'); return; }
        lyricStill = { idx, w, h, data: sampleToRgba(s, w, h, 'fill') };
        frameCache.set(`${idx}:${w}x${h}`, lyricStill);
        if (frameCache.size > 12) frameCache.delete(frameCache.keys().next().value);   // コマ戻し用に最近のコマを少しだけ取っておく
      }
    }
    if (bg) {
      const key = bg.isImage ? `img:${w}x${h}` : `vid:${idx}:${w}x${h}`;
      if (!bgStill || bgStill.key !== key) {
        let data;
        if (bg.isImage) data = bgImageRgba(w, h);
        else {
          const s = await bgFrameAt(t);
          if (gen !== previewGen) return;
          data = s ? sampleToRgba(s, w, h, 'cover') : new Uint8ClampedArray(w * h * 4);
        }
        bgStill = { key, data };
      }
    } else bgStill = null;
    if (gen !== previewGen) return;
    await showStill();
  }

  /** 調整を変えたとき：コマは読み直さず、合成だけやり直す */
  function requestComposite() {
    if (player) return;           // 再生中は次のコマから反映される
    if (!lyricStill) return;
    showStill();
  }

  async function showStill() {
    if (viewMode === 1 || !bgStill) {
      if (viewMode === 2 && !bgStill) { showMsg('背景が選ばれていません'); return; }
      drawRgba(viewMode === 2 ? bgStill.data : lyricStill.data, lyricStill.w, lyricStill.h);
      if (viewMode === 0 && !bgStill) el.lblPlayInfo.textContent = '（背景を選ぶと合成結果が表示されます）';
      return;
    }
    if (viewMode === 2) { drawRgba(bgStill.data, lyricStill.w, lyricStill.h); return; }
    // 合成：計算中に値が変わったら、終わってからもう 1 回だけ計算する
    // 計算中に呼ばれたときも、その計算（やり直しを含む）が終わるまで待つ
    // （コマ送りで、絵ができる前にバーだけ先へ進まないように）
    if (compositeBusy) { compositePending = true; return compositeDone; }
    compositeBusy = true;
    let doneResolve;
    compositeDone = new Promise(r => { doneResolve = r; });
    try {
      do {
        compositePending = false;
        const fgData = lyricStill.data, w = lyricStill.w, h = lyricStill.h, idx = lyricStill.idx;
        const out = await pool.process(fgData.slice(), bgStill.data, w, h, timeline.at(idx / fps()), { key: 'still' });
        if (player) break;
        if (lyricStill && lyricStill.idx === idx && viewMode === 0) drawRgba(out, w, h);
      } while (compositePending && lyricStill && !player);
    } finally { compositeBusy = false; doneResolve(); }
    if (!player && lyricStill && viewMode === 0) el.lblPlayInfo.textContent = '';
  }

  // ---- GPU（再生中のプレビュー用） ----
  let gpu = null, gpuFailed = false;
  function getGpu() {
    if (gpu || gpuFailed) return gpu;
    try { gpu = new GpuCompositor($('previewGL')); }
    catch (e) { gpuFailed = true; console.warn('GPU を使えません:', e); toast('このブラウザでは GPU で再生できないので、ふつうの方法で再生します。', 6000); }
    return gpu;
  }
  function showGl(on) {
    $('previewGL').hidden = !on;
    if (on) { el.preview.style.display = 'none'; el.previewMsg.hidden = true; }
  }

  function drawRgba(data, w, h) {
    showGl(false);
    if (el.preview.width !== w || el.preview.height !== h) { el.preview.width = w; el.preview.height = h; }
    ctxPreview.putImageData(new ImageData(data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data), w, h), 0, 0);
    el.preview.style.display = 'block';
    el.previewMsg.hidden = true;
  }
  function showMsg(text) {
    showGl(false);
    el.preview.style.display = 'none';
    el.previewMsg.hidden = false;
    el.previewMsg.textContent = text;
  }

  for (const [rb, v] of [[el.rbViewComposite, 0], [el.rbViewLyric, 1], [el.rbViewBg, 2]])
    rb.addEventListener('change', () => { if (rb.checked) { viewMode = v; if (!player && lyricStill) showStill(); } });

  // ------------------------------------------------------------------
  // 再生
  // ------------------------------------------------------------------
  class Player {
    constructor(start) {
      this.start = start;
      this.stopped = false;
      this.audio = null;
      this.clockStart = 0;       // performance.now() の値（ミリ秒）
      this.clockRunning = false;
      this.shown = 0;
      this.fpsWatch = performance.now();
      this.displayFps = 0;
      this.lastShow = -1e9;
      this.position = start;
    }

    playSize() {
      const sw = lyric.width, sh = lyric.height;
      const q = +el.cmbPlaySize.value;
      let w = sw;
      if (q === 0) {
        // 画面の表示枠の大きさ（拡大率は掛けない。高解像度の画面でも計算量が増えすぎないように）
        // GPU のときは画面の細かさ（拡大率）まで使ってくっきり表示する
        const dpr = this.gpu ? Math.min(2, window.devicePixelRatio || 1) : 1;
        const fw = el.previewHost.clientWidth * dpr, fh = el.previewHost.clientHeight * dpr;
        w = Math.floor(sw * Math.min(1, fw / sw, fh / sh));
        // スマホ・タブレットで CPU を使うときは計算が重いので、画素数を 540×304 くらいまでにする
        if (!this.gpu && document.body.classList.contains('mobile')) w = Math.min(w, Math.floor(Math.sqrt(540 * 304 * sw / sh)));
      } else if (q !== 4) {
        const max = q === 5 ? 360 : [0, 640, 960, 1280][q];
        if (sw > max) w = max;
      }
      const h = Math.round(sh * w / sw);
      return [Math.max(2, w & ~1), Math.max(2, h & ~1)];
    }

    now() { return this.clockRunning ? (performance.now() - this.clockStart) / 1000 : 0; }

    async startClock() {
      if (el.chkSound.checked && lyric.hasAudio) {
        const a = new Audio();
        a.src = URL.createObjectURL(lyric.file);
        a.preload = 'auto';
        a.volume = volumeLevel();
        a.currentTime = this.start;
        this.audio = a;
        // 音の再生が始まるのを待つ（途中から再生するときは時間がかかることがあるので、最大 1.5 秒で映像を先に進める）
        try { await Promise.race([a.play(), sleep(1500)]); } catch { /* 音が出せなくても映像は再生する */ }
        if (this.stopped) { this.stopAudio(); return; }
      }
      this.clockStart = performance.now() - (this.audio && !this.audio.paused ? (this.audio.currentTime - this.start) * 1000 : 0);
      this.clockRunning = true;
    }

    syncClock() {
      // 音とのずれを直す（音を基準にする）
      const a = this.audio;
      if (!a || a.paused || a.ended) return;
      const drift = (a.currentTime - this.start) - this.now();
      if (Math.abs(drift) > 0.08) this.clockStart -= drift * 1000;
    }

    stopAudio() {
      const a = this.audio;
      this.audio = null;
      if (a) { try { a.pause(); } catch { } URL.revokeObjectURL(a.src); a.removeAttribute('src'); }
    }

    stop() {
      this.stopped = true;
      this.stopAudio();
      // 待っている読む側・見せる側を起こして、すぐ終わらせる
      // （起こさないと、ためていたコマがデコーダーに返されず、次の再生でコマが読めなくなる）
      this.signal();
      if (this.q) {
        for (const j of this.q) {
          if (j.fg) { try { j.fg.close(); } catch { } j.fg = null; }
          if (j.bg) { try { j.bg.close(); } catch { } j.bg = null; }
        }
      }
    }

    /**
     * 再生の流れ：
     *   読む側（produce）… 動画のコマを読み、計算スレッドへ合成を頼んで、表示待ちの列に並べる
     *   見せる側（consume）… 列の先頭から、表示する時刻になったら画面に出す
     * 2 つを同時に進めるので、表示の時刻を待っている間も次のコマの準備が進む。
     */
    async run() {
      this.gpu = el.chkGpu.checked ? getGpu() : null;
      const [w, h] = this.playSize();
      this.w = w; this.h = h;
      this.frameDur = 1 / fps();
      this.q = [];
      this.producerDone = false;
      this.maxQ = PLAY_WORKERS * 2 + 2;          // 先に用意しておくコマの数
      this.stat = { read: 0, conv: 0, comp: 0, made: 0, skipped: 0, waitedJob: 0 };   // 重さの内訳（診断表示用）
      this.waiters = [];                         // 読む側・見せる側を起こす合図を待っている人
      let error = null;
      if (this.gpu) {
        this.maxQ = 6;                            // 先に用意しておくコマの数（枠は 12 個を順番に使う）
        this.gpu.resize(w, h);
        // 背景色の推定に使う縮小の大きさ。GPU で推定するときは横 120（軽い）、計算スレッドのときは CPU と同じ横 240
        const ew0 = this.gpu.floatOk ? 120 : 240;
        this.ew = Math.min(ew0, w); this.eh = Math.max(1, Math.round(h * this.ew / w));
        this.gpu.prepareEstimate(this.ew, this.eh, 12);
      }
      const producer = (this.gpu ? this.produceGpu(w, h) : this.produce(w, h))
        .catch(e => { error = error || e; }).finally(() => { this.producerDone = true; this.signal(); });
      try { await (this.gpu ? this.consumeGpu() : this.consume()); } catch (e) { error = error || e; }
      this.stopped = this.stopped || !!error;
      this.signal();
      await producer;
      for (const j of this.q) {
        if (j.job) j.job.catch(() => { });
        if (j.est) j.est.catch(() => { });
        if (j.fg) try { j.fg.close(); } catch { }
        if (j.bg) try { j.bg.close(); } catch { }
      }
      return error;
    }

    // ---- GPU で再生するとき ----
    async produceGpu(w, h) {
      const bReader = bg && !bg.isImage ? new SequentialReader(bg, this.start, true) : null;
      const frameDur = this.frameDur;
      const it = lyric.sink.samples(lyric.firstTimestamp + this.start);
      try {
        for (; ;) {
          while (this.q.length >= this.maxQ && !this.stopped) await this.waitSignal();
          if (this.stopped) break;
          const r = await it.next();
          if (r.done) break;
          const s = r.value;
          if (this.stopped) { s.close(); break; }
          const t = s.timestamp - lyric.firstTimestamp;
          if (t < this.start - frameDur * 0.5) { s.close(); continue; }
          const due = t - this.start;
          if (this.clockRunning && this.now() > due + frameDur * 0.5 && this.now() - this.lastShow < 0.3) {
            s.close();
            this.stat.skipped++;
            if (bReader) await bReader.frameAt(t + 1e-4);
            continue;
          }
          const p0 = performance.now();
          // コマを GPU に 1 回だけ送り、計算する大きさのコマと背景、背景色の推定用の縮小を作る。
          // 送ったらすぐにコマを閉じてデコーダーに返す（先読みを増やしても止まらないように）
          let bgSrc = null, bgKey = null, bgFrame = null;
          if (bReader) { const b = await bReader.frameAt(t + 1e-4); if (b) bgFrame = bgSrc = b.toVideoFrame(); }
          else if (bg && bg.isImage) { bgSrc = bg.bitmap; bgKey = 'img:' + bg.name + ':' + bg.file.size; }
          if (this.stopped) { s.close(); if (bgFrame) bgFrame.close(); break; }
          let prepared;
          const vf = s.toVideoFrame();
          try { prepared = this.gpu.prepareFrame(vf, bgSrc, bgKey); }
          finally { vf.close(); s.close(); if (bgFrame) bgFrame.close(); }
          // 背景色の推定
          let est = prepared.est;
          if (!est && !this.estBusy) {
            // GPU で推定できないとき：計算スレッドに頼む。前の推定が終わるまでは次を頼まない（仕事がたまらないように）
            this.estBusy = true;
            est = this.gpu.readAsync(prepared.slot.sm, this.ew, this.eh)
              .then(px => pool.estimate(px, this.ew, this.eh, { key: 'playest', reuse: 8 }))
              .finally(() => { this.estBusy = false; });
          }
          this.stat.read += performance.now() - p0;
          const entry = { t, due, slot: prepared.slot, est, ready: !est };
          if (est) est.then(r => {
            entry.ready = true;
            // 終わった中でいちばん新しい推定を覚えておく（表示に間に合わなかったコマの推定も捨てずに使う）
            if (r && (this.latestEstT === undefined || t >= this.latestEstT)) { this.latestEst = r; this.latestEstT = t; this.latestEstUsed = false; }
          }, () => { entry.ready = true; });
          this.q.push(entry);
          this.signal();
        }
      } finally {
        try { it.return(); } catch { }
        if (bReader) bReader.close();
      }
    }

    async consumeGpu() {
      for (; ;) {
        if (!this.clockRunning) {
          const need = Math.min(this.maxQ, 3);
          while (!this.stopped && !this.producerDone && this.q.length < need) await this.waitSignal();
        }
        while (!this.stopped && !this.producerDone && this.q.length === 0) await this.waitSignal();
        if (this.stopped || this.q.length === 0) return;
        const job = this.q[0];
        const w0 = performance.now();
        let est = null;
        if (job.est) {
          if (job.ready || !this.haveEst) { try { est = await job.est; } catch { est = null; } }
          else {
            // 背景色の推定がまだ：表示の時刻までは待つが、間に合わなければ前のコマの推定のまま描く（カクつきを防ぐ）
            const left = Math.max(0, job.due - this.now()) * 1000;
            const r = await Promise.race([job.est.catch(() => null), sleep(left).then(() => undefined)]);
            est = r === undefined ? null : r;
          }
        }
        this.stat.waitedJob += performance.now() - w0;
        this.q.shift();
        this.signal();
        const close = () => { };      // コマは prepareFrame のあとすぐ閉じているので、ここでは何もしない
        if (this.stopped) { close(); return; }
        // このコマの推定が間に合わなかったときは、終わった中でいちばん新しい推定を使う
        if (!est && this.latestEst && !this.latestEstUsed) est = this.latestEst;
        if (est) {
          if (est === this.latestEst) this.latestEstUsed = true;
          if (est.est) this.gpu.useEstimate(est);                    // GPU で推定した枠
          else { this.gpu.setEstimate(est, est.sw || this.ew, est.sh || this.eh); this.stat.comp += est.timing ? est.timing.comp : 0; }
          this.haveEst = true;
        }
        if (!this.clockRunning) { await this.startClock(); if (this.stopped) { close(); return; } }
        this.syncClock();
        const next = this.q[0];
        if (next && this.now() > next.due && next.ready) { close(); this.stat.skipped++; continue; }
        const wait = job.due - this.now();
        if (wait > 0.002) await sleep(wait * 1000);
        if (this.stopped) return;
        const g0 = performance.now();
        this.gpu.renderSlot(job.slot, timeline.at(job.t), viewMode);
        this.stat.conv += performance.now() - g0;
        this.stat.made++;
        showGl(true);
        this.position = this.start + job.due;
        this.lastShow = this.now();
        curTime = this.position;
        updateTime();
        this.shown++;
        const el2 = performance.now() - this.fpsWatch;
        if (el2 >= 1000) {
          this.displayFps = this.shown * 1000 / el2;
          this.shown = 0;
          this.fpsWatch = performance.now();
          const st = this.stat, m = Math.max(1, st.made);
          el.lblPlayInfo.textContent = `再生中（GPU）　${this.displayFps.toFixed(0)} コマ/秒（${this.w}×${this.h}）` +
            `　｜読込 ${(st.read / Math.max(1, m + st.skipped)).toFixed(0)}ms　描画 ${(st.conv / m).toFixed(1)}ms　${this.gpu.floatOk ? '背景色の推定 GPU' : `背景色の推定 ${(st.comp / m).toFixed(0)}ms`}` +
            `　待ち ${(st.waitedJob / m).toFixed(0)}ms　飛ばし ${st.skipped}`;
          this.stat = { read: 0, conv: 0, comp: 0, made: 0, skipped: 0, waitedJob: 0 };
          updateSegInfo();
        }
      }
    }

    // 待っている側をすべて起こす（読む側と見せる側が同時に待っても取りこぼさないように、待ち手を全部覚えておく）
    signal() { const ws = this.waiters || []; this.waiters = []; for (const f of ws) f(); }
    waitSignal() { return new Promise(r => { (this.waiters = this.waiters || []).push(r); }); }

    async produce(w, h) {
      const bReader = bg && !bg.isImage ? new SequentialReader(bg, this.start, true) : null;
      const bgImg = bg && bg.isImage ? bgImageRgba(w, h) : null;
      const frameDur = this.frameDur;
      const it = lyric.sink.samples(lyric.firstTimestamp + this.start);
      let n = 0;
      try {
        for (; ;) {
          while (this.q.length >= this.maxQ && !this.stopped) await this.waitSignal();
          if (this.stopped) break;
          const r = await it.next();
          if (r.done) break;
          const s = r.value;
          if (this.stopped) { s.close(); break; }
          const t = s.timestamp - lyric.firstTimestamp;
          if (t < this.start - frameDur * 0.5) { s.close(); continue; }      // 始める位置より前のコマ
          const due = t - this.start;
          // 表示の時刻をもう過ぎているコマは作らずに飛ばす（ただし 0.3 秒以上何も出ていなければ 1 コマは出す）
          if (this.clockRunning && this.now() > due + frameDur * 0.5 && this.now() - this.lastShow < 0.3) {
            s.close();
            this.stat.skipped++;
            if (bReader) await bReader.frameAt(t + 1e-4);   // 背景動画も同じだけ進めておく
            continue;
          }
          const view = viewMode;
          const mode = view === 1 || !bg ? 'fg' : view === 2 ? 'bg' : 'composite';
          const p0 = performance.now();
          // コマのデータを取り出すだけにして、大きさの変更と合成は Worker で行う（画面側を軽くする）
          const fgSrc = mode === 'bg' ? null : await frameForWorker(s, w, h, 'fill', 'medium');
          s.close();
          let bgSrc = null;
          if (mode !== 'fg') {
            if (bReader) {
              const b = await bReader.frameAt(t + 1e-4);
              bgSrc = b ? await frameForWorker(b, w, h, 'cover', 'medium') : { rgba: new ArrayBuffer(w * h * 4) };
            } else bgSrc = { rgba: bgImg.slice().buffer };
          } else if (bReader) await bReader.frameAt(t + 1e-4);
          this.stat.read += performance.now() - p0;
          // 再生中は軽い計算（Fast）にする。止めたときの表示と書き出しは、正確な計算のまま
          const st = timeline.at(t);
          st.Fast = true;
          // 空いている計算スレッドに頼む（スマホは速いコアと遅いコアが混ざっているので、順番に割り振るより速い）
          const job = pool.processSrc(fgSrc, bgSrc, w, h, st, { mode, key: 'play', reuse: 16, workers: PLAY_WORKERS });
          const entry = { t, due, job, ready: false };
          job.then(() => { entry.ready = true; }, () => { });
          this.q.push(entry);
          n++;
          this.signal();
        }
      } finally {
        try { it.return(); } catch { }
        if (bReader) bReader.close();
      }
    }

    async consume() {
      for (; ;) {
        // 最初は、何コマか用意できてから時計を動かす（始まりのカクつきを防ぐ）
        if (!this.clockRunning) {
          const need = Math.min(this.maxQ, PLAY_WORKERS + 1);
          while (!this.stopped && !this.producerDone && this.q.length < need) await this.waitSignal();
        }
        while (!this.stopped && !this.producerDone && this.q.length === 0) await this.waitSignal();
        if (this.stopped || this.q.length === 0) return;
        const job = this.q[0];
        const w0 = performance.now();
        const out = await job.job;
        this.stat.waitedJob += performance.now() - w0;
        this.stat.made++;
        if (out.timing) { this.stat.conv += out.timing.conv; this.stat.comp += out.timing.comp; }
        this.q.shift();
        this.signal();
        if (this.stopped) return;
        if (!this.clockRunning) { await this.startClock(); if (this.stopped) return; }
        this.syncClock();
        // 遅れていて、次のコマがもう出来ているなら、このコマは見せずに次へ
        const next = this.q[0];
        if (next && this.now() > next.due && next.ready) continue;
        const wait = job.due - this.now();
        if (wait > 0.002) await sleep(wait * 1000);
        if (this.stopped) return;
        drawRgba(out, this.w, this.h);
        this.position = this.start + job.due;
        this.lastShow = this.now();
        curTime = this.position;
        updateTime();
        this.shown++;
        const el2 = performance.now() - this.fpsWatch;
        if (el2 >= 1000) {
          this.displayFps = this.shown * 1000 / el2;
          this.shown = 0;
          this.fpsWatch = performance.now();
          const st = this.stat, m = Math.max(1, st.made);
          // 診断：読込 = 動画からコマを取り出す時間、変換・合成 = 計算スレッドでの 1 コマあたりの時間
          el.lblPlayInfo.textContent = `再生中　${this.displayFps.toFixed(0)} コマ/秒（${this.w}×${this.h}）` +
            `　｜読込 ${(st.read / Math.max(1, m + st.skipped)).toFixed(0)}ms　変換 ${(st.conv / m).toFixed(0)}ms　合成 ${(st.comp / m).toFixed(0)}ms` +
            `（${PLAY_WORKERS}並列）　待ち ${(st.waitedJob / m).toFixed(0)}ms　飛ばし ${st.skipped}`;
          el.lblPlayInfo.title = '読込：画面側で動画からコマを取り出す時間\n変換：計算スレッドで大きさを変える時間\n合成：計算スレッドで背景を抜いて重ねる時間\n待ち：表示の順番が来たのに合成が終わっていなかった時間\n飛ばし：間に合わず表示しなかったコマの数';
          this.stat = { read: 0, conv: 0, comp: 0, made: 0, skipped: 0, waitedJob: 0 };
          updateSegInfo();
        }
      }
    }
  }

  function volumeLevel() { const r = +el.trkVolume.value / 100; return r * r; }   // 耳で聞いた大きさに近づけるため 2 乗

  async function startPlayback() {
    if (!lyric || player || exporting) return;
    let start = curTime;
    if (start >= lastFrameTime() - 1.5 / fps()) start = 0;   // 最後まで行っていたら最初から
    // 止まっているときの表示用に開いている動画の読み込みを閉じる（スマホは同時に使える動画の読み込みの数が少ないため）
    closeStillReaders();
    const pl = new Player(start);
    player = pl;
    el.btnPlay.innerHTML = '<span class="pi">■</span><span class="pt">停止</span>';
    el.lblPlayInfo.textContent = '準備しています...';
    updateButtons();
    const err = await pl.run();
    if (player !== pl) return;           // 途中で止められた
    if (!err) pl.position = lastFrameTime();   // 最後まで再生した
    stopPlayback(true);
    if (err) alert('再生できませんでした。\n' + err.message);
  }

  function stopPlayback(refreshStill = true) {
    const pl = player;
    if (!pl) return;
    player = null;
    pl.stop();
    pool.clear('play');
    curTime = clamp(frameIndexOf(pl.position), 0, lastFrameIndex()) / fps();
    el.btnPlay.innerHTML = '<span class="pi">▶</span><span class="pt">再生</span>';
    // 止めた位置は正確な計算で表示し直す（スマホでは数秒かかることがあるので、そのことを表示する）
    el.lblPlayInfo.textContent = refreshStill ? '止めた位置を正確な計算で表示し直しています...' : '';
    updateTime();
    updateSegInfo();
    updateButtons();
    if (refreshStill) requestPreview(true);
  }

  el.btnPlay.addEventListener('click', () => { if (player) stopPlayback(true); else startPlayback(); });
  el.chkSound.addEventListener('change', () => {
    if (player && player.audio) player.audio.muted = !el.chkSound.checked;
    savePrefsSoon();
  });
  function applyVolume() {
    el.lblVolume.textContent = el.trkVolume.value + '%';
    if (player && player.audio) player.audio.volume = volumeLevel();
  }
  el.trkVolume.addEventListener('input', () => { applyVolume(); savePrefsSoon(); });
  el.trkVolume.addEventListener('wheel', e => {
    e.preventDefault();
    el.trkVolume.value = clamp(+el.trkVolume.value + (e.deltaY < 0 ? 5 : -5), 0, 100);
    applyVolume(); savePrefsSoon();
  }, { passive: false });
  el.cmbPlaySize.addEventListener('change', savePrefsSoon);
  el.chkOutSameDir.addEventListener('change', savePrefsSoon);
  el.chkGpu.addEventListener('change', savePrefsSoon);

  // 全画面
  // 全画面にしたとき、画面の上に「ダブルタップで戻ります」を出して 3 秒で消す
  let fullHintTimer = 0;
  function showFullHint(on) {
    const n = $('fullHint');
    clearTimeout(fullHintTimer);
    if (!on) { n.hidden = true; return; }
    const mobile = document.body.classList.contains('mobile');
    n.textContent = mobile ? 'ダブルタップで戻ります' : 'ダブルクリック（または Esc）で戻ります';
    n.classList.remove('fade');
    n.hidden = false;
    fullHintTimer = setTimeout(() => {
      n.classList.add('fade');
      fullHintTimer = setTimeout(() => { n.hidden = true; }, 400);
    }, 3000);
  }
  function toggleFullScreen() {
    const full = !document.body.classList.contains('full');
    document.body.classList.toggle('full', full);
    updateLayout();
    showFullHint(full);
    try {
      if (full && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => { });
      if (!full && document.fullscreenElement) document.exitFullscreen().catch(() => { });
    } catch { }
  }
  el.btnFull.addEventListener('click', toggleFullScreen);
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('full')) {
      document.body.classList.remove('full');
      updateLayout();
      showFullHint(false);
    }
  });
  el.previewHost.addEventListener('dblclick', () => { if (lyric) toggleFullScreen(); });

  // ------------------------------------------------------------------
  // 区間
  // ------------------------------------------------------------------
  function rebuildTimeline() { timeline = new SegmentTimeline(segments, currentSettings()); }

  function onSegmentsChanged(dirty = true) {
    if (dirty) segmentsDirty = true;
    segments.sort((a, b) => a.Start - b.Start);
    rebuildTimeline();
    refreshSegmentUi();
    requestComposite();
  }

  function refreshSegmentUi() {
    if (selectedSeg && !segments.includes(selectedSeg)) selectedSeg = null;
    drawSegBar();
    updateSegInfo();
    updateButtons();
  }

  function updateSegInfo() {
    let mark = '';
    if (markStart != null || markEnd != null)
      mark = `ここから ${markStart != null ? fmtSeg(markStart) : '―'} ～ ここまで ${markEnd != null ? fmtSeg(markEnd) : '―'}　`;
    const inSeg = segments.find(sg => contains(sg, curTime));
    const where = inSeg
      ? `今の位置：区間 ${fmtSeg(inSeg.Start)}～${fmtSeg(inSeg.End)}（抜き具合 ${Math.round(inSeg.Settings.KeyThreshold)}・縁取り ${Math.round(inSeg.Settings.OutlineRadius)}・粒 ${Math.round(inSeg.Settings.NoiseSize)}）`
      : segments.length ? '今の位置：区間の外（③ 調整の設定）' : '';
    el.lblSegInfo.textContent = mark + where + (segmentsDirty ? '　※未保存' : '');
  }

  const overlaps = (start, end, except) => segments.some(sg => sg !== except && start <= sg.End && end >= sg.Start);

  el.btnMarkStart.addEventListener('click', () => {
    markStart = curTime; if (markEnd != null && markEnd <= markStart) markEnd = null; refreshSegmentUi();
  });
  el.btnMarkEnd.addEventListener('click', () => {
    markEnd = curTime; if (markStart != null && markStart >= markEnd) markStart = null; refreshSegmentUi();
  });
  el.btnAddSeg.addEventListener('click', () => {
    if (!lyric || markStart == null || markEnd == null) return;
    if (markEnd <= markStart) { alert('「ここまで」は「ここから」より後の位置にしてください。'); return; }
    if (overlaps(markStart, markEnd, null)) { alert('ほかの区間と重なっています。重ならない位置を指定してください。'); return; }
    // 最初は ③ 調整（全体）と同じ値から始める
    const seg = { Start: markStart, End: markEnd, Settings: currentSettings() };
    segments.push(seg);
    selectedSeg = seg;
    markStart = markEnd = null;
    onSegmentsChanged();
  });
  el.btnEditSeg.addEventListener('click', () => { if (selectedSeg) editSegment(selectedSeg); });
  el.btnDelSeg.addEventListener('click', () => { if (selectedSeg) deleteSegment(selectedSeg); });

  function deleteSegment(seg) {
    if (!confirm(`区間 ${fmtSeg(seg.Start)} ～ ${fmtSeg(seg.End)} を削除しますか？`)) return;
    if (segDlg && segDlg.target === seg) closeSegDialog(false);
    segments.splice(segments.indexOf(seg), 1);
    if (selectedSeg === seg) selectedSeg = null;
    onSegmentsChanged();
  }

  // ---- 区間のバー ----
  const segCtx = el.segBar.getContext('2d');
  let hoverSeg = null;
  const BAR_M = 9;     // スライダーのつまみの動く範囲に合わせるための左右の余白
  function barMetrics() {
    const w = el.segBar.clientWidth;
    return { w, m: BAR_M, tw: Math.max(1, w - 2 * BAR_M) };
  }
  const durationForBar = () => lyric ? Math.max(1e-6, lastFrameTime()) : 0;
  function xOf(t) { const { m, tw } = barMetrics(); const d = durationForBar(); return d <= 0 ? m : m + (t / d) * tw; }
  function timeOf(x) { const { m, tw } = barMetrics(); return clamp((x - m) / tw, 0, 1) * durationForBar(); }
  function segmentAt(x) {
    for (const s of segments) {
      const x0 = xOf(s.Start), x1 = Math.max(xOf(s.End), x0 + 4);
      if (x >= x0 - 2 && x <= x1 + 2) return s;
    }
    return null;
  }

  function drawSegBar() {
    const dpr = window.devicePixelRatio || 1;
    const cw = el.segBar.clientWidth, ch = el.segBar.clientHeight || 24;
    if (el.segBar.width !== Math.round(cw * dpr) || el.segBar.height !== Math.round(ch * dpr)) {
      el.segBar.width = Math.round(cw * dpr); el.segBar.height = Math.round(ch * dpr);
    }
    const g = segCtx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const { m, tw } = barMetrics();
    const ty = 3, th = ch - 7;
    g.fillStyle = '#fafafa'; g.fillRect(m, ty, tw, th);
    g.strokeStyle = '#787878'; g.lineWidth = 1; g.strokeRect(m + 0.5, ty + 0.5, tw, th);
    if (!lyric) return;
    for (const s of segments) {
      const x0 = xOf(s.Start), x1 = Math.max(xOf(s.End), x0 + 3);
      g.fillStyle = s === selectedSeg ? 'rgb(200,20,20)' : s === hoverSeg ? 'rgb(240,70,70)' : 'rgb(225,40,40)';
      g.fillRect(x0, ty + 1, x1 - x0, th - 1);
      if (s === selectedSeg) { g.strokeStyle = '#000'; g.lineWidth = 2; g.strokeRect(x0, ty + 1, x1 - x0, th - 1); }
    }
    const mark = (t, c) => {
      const x = xOf(t);
      g.strokeStyle = c; g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(x, ty - 2); g.lineTo(x, ty + th + 2); g.stroke();
      g.fillStyle = c; g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 6); g.fill();
    };
    if (markStart != null) mark(markStart, 'rgb(0,150,60)');
    if (markEnd != null) mark(markEnd, 'rgb(0,90,200)');
    if (markStart != null && markEnd != null && markEnd > markStart) {
      g.fillStyle = 'rgba(0,120,200,0.27)';
      g.fillRect(xOf(markStart), ty + 1, xOf(markEnd) - xOf(markStart), th - 1);
    }
    const px = xOf(curTime);
    g.strokeStyle = '#141414'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, ch); g.stroke();
  }
  window.addEventListener('resize', drawSegBar);

  el.segBar.addEventListener('pointerdown', e => {
    if (!lyric || exporting || e.button !== 0) return;
    const s = segmentAt(e.offsetX);
    if (s) { if (selectedSeg !== s) { selectedSeg = s; refreshSegmentUi(); } }
    else { selectedSeg = null; refreshSegmentUi(); seekTo(timeOf(e.offsetX)); }
  });
  el.segBar.addEventListener('dblclick', e => {
    const s = segmentAt(e.offsetX);
    if (s) editSegment(s);
  });
  el.segBar.addEventListener('pointermove', e => {
    const s = segmentAt(e.offsetX);
    if (s !== hoverSeg) {
      hoverSeg = s;
      drawSegBar();
      el.segBar.title = s ? `区間 ${fmtSeg(s.Start)} ～ ${fmtSeg(s.End)}　（ダブルクリックで設定、右クリックでメニュー）`
        : 'クリックでその位置へ移動。赤い区間はダブルクリックで設定';
    }
  });
  el.segBar.addEventListener('pointerleave', () => { if (hoverSeg) { hoverSeg = null; drawSegBar(); } });
  el.segBar.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!lyric || exporting) return;
    const s = segmentAt(e.offsetX);
    const t = timeOf(e.offsetX);
    if (s && selectedSeg !== s) { selectedSeg = s; refreshSegmentUi(); }
    const items = s ? [
      { text: `区間 ${fmtSeg(s.Start)} ～ ${fmtSeg(s.End)}`, disabled: true }, { sep: true },
      { text: '区間設定', action: () => editSegment(s) },
      { text: '区間の始まりへ移動', action: () => seekTo(s.Start) },
      { text: '区間の終わりへ移動', action: () => seekTo(s.End) },
      { sep: true },
      { text: '区間削除', action: () => deleteSegment(s) },
    ] : [
      { text: `${fmtSeg(t)} を「ここから」にする`, action: () => { markStart = t; if (markEnd != null && markEnd <= markStart) markEnd = null; refreshSegmentUi(); } },
      { text: `${fmtSeg(t)} を「ここまで」にする`, action: () => { markEnd = t; if (markStart != null && markStart >= markEnd) markStart = null; refreshSegmentUi(); } },
      { text: 'ここから・ここまでの印を消す', action: () => { markStart = markEnd = null; refreshSegmentUi(); } },
    ];
    showMenuAt(e.clientX, e.clientY, items);
  });

  // ---- 右クリックメニュー ----
  function showMenuAt(x, y, items) {
    const menu = el.ctxMenu;
    menu.innerHTML = '';
    for (const it of items) {
      const d = document.createElement('div');
      if (it.sep) d.className = 'sep';
      else {
        d.textContent = it.text;
        if (it.disabled) d.className = 'disabled';
        else d.addEventListener('click', () => { hideMenu(); it.action(); });
      }
      menu.appendChild(d);
    }
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
    menu.style.top = Math.min(y, innerHeight - r.height - 4) + 'px';
  }
  function hideMenu() { el.ctxMenu.hidden = true; }
  document.addEventListener('pointerdown', e => { if (!el.ctxMenu.hidden && !el.ctxMenu.contains(e.target)) hideMenu(); });

  // ---- 区間の設定（小さな窓） ----
  let segDlg = null;    // { target, original, wasDirty }
  let sdCustom = [255, 255, 255];
  let sdLoading = false;

  function editSegment(seg) {
    if (!lyric) return;
    if (segDlg) {
      if (segDlg.target === seg) { if (pipWin) pipWin.focus(); return; }
      closeSegDialog(false, true);           // 前の区間の変更は取り消す（別の窓はそのまま使う）
    }
    selectedSeg = seg;
    refreshSegmentUi();
    if (!contains(seg, curTime)) seekTo(seg.Start);
    segDlg = { target: seg, original: { Start: seg.Start, End: seg.End, Settings: cloneSettings(seg.Settings) }, wasDirty: segmentsDirty };
    const step = Math.round(100 / fps()) / 100 || 0.01;
    for (const n of [el.sdStart, el.sdEnd]) { n.max = lyric.duration.toFixed(2); n.step = step; }
    loadDialogValues(seg);
    el.segDialog.hidden = false;
    updateLayout();
    if (document.body.classList.contains('split')) $('left').scrollTo({ top: 0, behavior: 'smooth' });
    // 前に「別の窓に出す」を使っていたら、今回も別の窓で開く
    if (!pipWin && prefs.SegDialogPopout && pipSupported()) popOutSegDialog();
  }

  function loadDialogValues(seg) {
    sdLoading = true;
    el.sdStart.value = seg.Start.toFixed(2);
    el.sdEnd.value = seg.End.toFixed(2);
    const st = seg.Settings;
    for (const [trk, nud, v] of [[el.sdTrkKey, el.sdNudKey, st.KeyThreshold], [el.sdTrkOutline, el.sdNudOutline, st.OutlineRadius], [el.sdTrkNoise, el.sdNudNoise, st.NoiseSize]]) {
      const x = clamp(Math.round(v), +trk.min, +trk.max); trk.value = x; nud.value = x;
    }
    sdCustom = [st.CustomR, st.CustomG, st.CustomB];
    el.sdCustom.value = hex(sdCustom);
    el.sdColor.value = String(st.OutlineMode);
    updateDialogTimeLabels();
    sdLoading = false;
  }
  function updateDialogTimeLabels() {
    el.sdStartLbl.textContent = fmtSeg(+el.sdStart.value || 0);
    el.sdEndLbl.textContent = fmtSeg(+el.sdEnd.value || 0);
    el.segDlgTitle.textContent = `区間の設定　${fmtSeg(+el.sdStart.value || 0)} ～ ${fmtSeg(+el.sdEnd.value || 0)}`;
    if (pipWin) pipWin.document.title = el.segDlgTitle.textContent;
  }

  function applyDialog() {
    if (sdLoading || !segDlg) return;
    const seg = segDlg.target;
    const max = lyric ? lyric.duration : 0;
    // 時間はコマの位置にそろえる（表示は 0.01 秒単位なので、そのままだとちょうどのコマが区間から外れることがある）
    const snap = v => clamp(Math.round((+v || 0) * fps()) / fps(), 0, max);
    seg.Start = snap(el.sdStart.value);
    seg.End = snap(el.sdEnd.value);
    seg.Settings = {
      KeyThreshold: +el.sdTrkKey.value, KeySoftness: 33, OutlineRadius: +el.sdTrkOutline.value, NoiseSize: +el.sdTrkNoise.value,
      OutlineMode: +el.sdColor.value, CustomR: sdCustom[0], CustomG: sdCustom[1], CustomB: sdCustom[2],
    };
    updateDialogTimeLabels();
    onSegmentsChanged();
  }
  linkSlider(el.sdTrkKey, el.sdNudKey, applyDialog);
  linkSlider(el.sdTrkOutline, el.sdNudOutline, applyDialog);
  linkSlider(el.sdTrkNoise, el.sdNudNoise, applyDialog);
  el.sdColor.addEventListener('change', applyDialog);
  el.sdCustom.addEventListener('input', () => { sdCustom = fromHex(el.sdCustom.value); if (el.sdColor.value !== '4') el.sdColor.value = '4'; applyDialog(); });
  el.sdStart.addEventListener('change', applyDialog);
  el.sdEnd.addEventListener('change', applyDialog);
  el.sdNowStart.addEventListener('click', () => { el.sdStart.value = curTime.toFixed(2); applyDialog(); });
  el.sdNowEnd.addEventListener('click', () => { el.sdEnd.value = curTime.toFixed(2); applyDialog(); });
  el.sdCopy.addEventListener('click', () => {
    if (!segDlg) return;
    const keep = { Start: segDlg.target.Start, End: segDlg.target.End, Settings: currentSettings() };
    loadDialogValues(keep);
    applyDialog();
  });
  el.sdOk.addEventListener('click', () => closeSegDialog(true));
  el.sdCancel.addEventListener('click', () => closeSegDialog(false));

  function closeSegDialog(accepted, keepWindow = false) {
    if (!segDlg) return;
    const d = segDlg;
    segDlg = null;
    if (!keepWindow) { el.segDialog.hidden = true; closePip(); }
    const seg = d.target;
    if (!accepted) {
      // キャンセル：開いたときの状態に戻す
      seg.Start = d.original.Start; seg.End = d.original.End; seg.Settings = d.original.Settings;
      segmentsDirty = d.wasDirty;
      onSegmentsChanged(false);
      return;
    }
    if (seg.End <= seg.Start) {
      alert('終わりが始まりより前になっていたので、入れ替えました。');
      [seg.Start, seg.End] = [seg.End, seg.Start];
    }
    if (overlaps(seg.Start, seg.End, seg))
      alert('この区間はほかの区間と重なっています。重なった部分では、始まりが早いほうの区間の設定が使われます。');
    onSegmentsChanged(true);
  }

  // 窓をドラッグで動かす
  function makeDraggable(win, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
    handle.addEventListener('pointerdown', e => {
      if (win.classList.contains('inPip')) return;    // 別の窓に出しているときは、窓そのものを動かす
      drag = true; handle.setPointerCapture(e.pointerId);
      const r = win.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      win.style.transform = 'none';
    });
    handle.addEventListener('pointermove', e => {
      if (!drag) return;
      win.style.left = clamp(ox + e.clientX - sx, 0, innerWidth - 60) + 'px';
      win.style.top = clamp(oy + e.clientY - sy, 0, innerHeight - 40) + 'px';
      win.style.right = 'auto';
    });
    handle.addEventListener('pointerup', () => { drag = false; });
  }
  makeDraggable(el.segDialog, $('segDlgBar'));

  // ---- 区間の設定を別の窓（ブラウザの外）に出す ----
  // Chrome・Edge の「ドキュメント ピクチャー イン ピクチャー」を使う。窓はいつも手前に表示され、画面のどこへでも動かせる。
  let pipWin = null;
  const sdPopout = $('sdPopout');     // 窓を移すと document から探せなくなるので、先に覚えておく
  const pipSupported = () => 'documentPictureInPicture' in window;

  async function popOutSegDialog() {
    if (pipWin) { pipWin.focus(); return; }
    if (!pipSupported()) {
      alert('このブラウザでは別の窓に出せません。Google Chrome か Microsoft Edge の最新版でお使いください。');
      return;
    }
    const dlg = el.segDialog;
    let w;
    try {
      w = await window.documentPictureInPicture.requestWindow({ width: 540, height: Math.min(720, dlg.scrollHeight + 20) });
    } catch (e) {
      // ボタンを押した直後でないと開けない（区間の設定を開いたときに自動で出せなかった場合など）
      toast('別の窓を開けませんでした。区間の設定の「⧉ 別の窓に出す」を押してください。', 6000);
      return;
    }
    pipWin = w;
    // 画面の見た目（CSS）を別の窓にも読み込む
    for (const link of document.querySelectorAll('link[rel=stylesheet]')) {
      const l = w.document.createElement('link');
      l.rel = 'stylesheet'; l.href = link.href;
      w.document.head.appendChild(l);
    }
    w.document.title = el.segDlgTitle.textContent;
    w.document.body.classList.add('pip');
    dlg.classList.add('inPip');
    dlg.style.left = dlg.style.top = dlg.style.right = ''; dlg.style.transform = '';
    w.document.body.append(dlg);
    sdPopout.textContent = '↩ ブラウザの中に戻す';
    sdPopout.title = 'この設定をブラウザの中に戻します';
    w.addEventListener('keydown', onKeyDown);       // 別の窓でも ← → でコマ送り、スペースで再生できる
    w.addEventListener('pagehide', () => {
      // 窓の × で閉じた：設定をブラウザの中に戻す。区間の設定は「キャンセル」と同じ扱い
      const byApp = w.closedByApp;
      if (pipWin === w) returnDialogFromPip();
      if (!byApp && segDlg) closeSegDialog(false);
    });
    prefs.SegDialogPopout = true;
    savePrefs();
  }

  function returnDialogFromPip() {
    const dlg = el.segDialog;
    if (dlg.ownerDocument !== document || dlg.parentNode !== document.body) document.body.append(dlg);
    dlg.classList.remove('inPip');
    pipWin = null;
    sdPopout.textContent = '⧉ 別の窓に出す';
    sdPopout.title = 'この設定をブラウザの外の別の窓に出します。窓は好きな場所に動かせて、いつも手前に表示されます';
  }

  function closePip() {
    if (!pipWin) return;
    const w = pipWin;
    w.closedByApp = true;          // アプリが閉じた（× で閉じたのとは区別する）
    returnDialogFromPip();
    try { w.close(); } catch { }
  }

  sdPopout.addEventListener('click', () => {
    if (pipWin) {
      // ブラウザの中に戻す（次からもブラウザの中で開く）
      prefs.SegDialogPopout = false;
      savePrefs();
      closePip();
      el.segDialog.hidden = !segDlg;
    } else popOutSegDialog();
  });
  sdPopout.addEventListener('pointerdown', e => e.stopPropagation());   // ボタンを押したときに窓を動かさない

  // ---- 区間の保存・読み込み ----
  el.btnSaveSeg.addEventListener('click', saveSegments);
  async function saveSegments() {
    if (!segments.length) return;
    const id = projectId || FileStore.newId();
    const text = saveProject({
      lyricName: lyric ? lyric.name : '', backgroundName: bg ? bg.name : '', backgroundIsVideo: el.rbBgVideo.checked,
      global: currentSettings(), segments, webFileId: id,
    });
    const name = (lyric ? lyric.name.replace(/\.[^.]+$/, '') : '区間') + '_区間.json';
    try {
      if (window.showSaveFilePicker) {
        // 保存の画面は、歌詞動画のあるフォルダーで開く
        const opts = { suggestedName: name, types: [{ description: '区間ファイル', accept: { 'application/json': ['.json'] } }] };
        if (lyricHandle) opts.startIn = lyricHandle;
        else opts.id = 'segments';
        const h = await window.showSaveFilePicker(opts);
        const w = await h.createWritable();
        await w.write(new Blob([text], { type: 'application/json' }));
        await w.close();
      } else {
        downloadBlob(new Blob([text], { type: 'application/json' }), name);
      }
      // 歌詞動画・背景の場所を、このブラウザに覚えておく
      if (FileStore.supported() && (lyricHandle || bgHandle)) {
        try {
          await FileStore.put(id, {
            lyric: lyricHandle, lyricInfo: lyricHandle && lyric ? FileStore.fileInfo(lyric.file) : null,
            bg: bgHandle, bgInfo: bgHandle && bg ? FileStore.fileInfo(bg.file) : null,
            backgroundIsVideo: el.rbBgVideo.checked,
          });
        } catch { /* 覚えられなくても区間ファイルは保存できている */ }
      }
      projectId = id;
      segmentsDirty = false;
      refreshSegmentUi();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      alert('保存できませんでした。\n' + e.message);
    }
  }

  el.btnLoadSeg.addEventListener('click', async () => {
    if (FileStore.supported()) {
      try {
        const hs = await window.showOpenFilePicker({
          id: 'segments', multiple: true,
          types: [{ description: '区間ファイル', accept: { 'application/json': ['.json'] } }, ...VIDEO_TYPES, ...IMAGE_TYPES],
        });
        const files = await Promise.all(hs.map(h => h.getFile()));
        loadSegmentsFromFiles(files, hs);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    el.fileSeg.accept = '.json,application/json,video/*,image/*';
    el.fileSeg.multiple = true;
    el.fileSeg.click();
  });
  el.fileSeg.addEventListener('change', () => { const fs = [...el.fileSeg.files]; el.fileSeg.value = ''; if (fs.length) loadSegmentsFromFiles(fs); });

  /**
   * 区間ファイルを読む。歌詞動画・背景は次の順に探して、自動でセットする。
   *   1. 区間ファイルといっしょに選んだ（落とした）ファイルの中
   *   2. 区間を保存したときに、このブラウザに覚えておいた場所
   *   3. 選んでもらったフォルダーの中（同じ名前のファイル）
   * 保存したときと場所や中身が変わっていたら、使ってよいか確認する。
   */
  async function loadSegmentsFromFiles(files, handles = []) {
    if (exporting) return;
    const ji = files.findIndex(f => /\.json$/i.test(f.name));
    if (ji < 0) return;
    let proj;
    try { proj = loadProject(await files[ji].text()); }
    catch (e) { alert('読み込めませんでした。\n' + e.message); return; }
    if (!confirmDiscardSegments()) return;
    segmentsDirty = false;

    const others = files.map((f, k) => ({ file: f, handle: handles[k] || null })).filter((x, k) => k !== ji);
    const pickedByName = name => name && others.find(x => x.file.name.toLowerCase() === name.toLowerCase());
    const isCurrent = (m, name) => m && m.name.toLowerCase() === (name || '').toLowerCase();

    let rec = null;
    if (proj.webFileId && FileStore.supported()) { try { rec = await FileStore.get(proj.webFileId); } catch { } }

    // ---- いっしょに選んだファイル・覚えておいた場所から探す ----
    const want = [];
    let lyricSrc = pickedByName(proj.lyricName) || null;
    if (!lyricSrc && proj.lyricName && !isCurrent(lyric, proj.lyricName)) want.push({ kind: 'lyric', label: '歌詞動画', name: proj.lyricName, rh: rec && rec.lyric, info: rec && rec.lyricInfo });
    let bgSrc = pickedByName(proj.backgroundName) || null;
    if (!bgSrc && proj.backgroundName && !isCurrent(bg, proj.backgroundName)) want.push({ kind: 'bg', label: '背景', name: proj.backgroundName, rh: rec && rec.bg, info: rec && rec.bgInfo });

    const found = {};
    const recorded = want.filter(w => w.rh);
    if (recorded.length) {
      const res = await openRecorded(recorded);
      Object.assign(found, res);
    }
    // ---- 見つからなかったものは、フォルダーを選んでもらって探す ----
    const missing = want.filter(w => !found[w.kind] && !w.declined);
    if (missing.length && window.showDirectoryPicker) {
      const names = missing.map(w => `${w.label}「${w.name}」`).join('、');
      const lost = missing.some(w => w.rh);
      const ans = await askButtons(
        (lost ? `保存したときの場所に、${names} が見つかりませんでした（移動したか、名前が変わった可能性があります）。`
              : `${names} の場所がわかりません（別のパソコン・Windows 版で保存した区間ファイルなど）。`) +
        '\n\nファイルのあるフォルダーを選ぶと、その中（サブフォルダーも含む）から同じ名前のファイルを探してセットします。',
        [{ label: 'フォルダーを選んで探す', value: 'dir', bold: true }, { label: '探さない', value: 'skip' }], 'ファイルを探す');
      if (ans === 'dir') {
        let dir = null;
        try {
          const opts = { id: 'segments-folder', mode: 'read' };
          if (lyricHandle) opts.startIn = lyricHandle;
          dir = await window.showDirectoryPicker(opts);
        } catch { dir = null; }
        if (dir) {
          let map = new Map();
          try { map = await FileStore.findInDir(dir, missing.map(w => w.name)); } catch { }
          for (const w of missing) {
            const hit = map.get(w.name.toLowerCase());
            if (!hit) continue;
            // 覚えておいた場所と違う所で見つかった：使ってよいか確認する
            if (w.rh && !confirm(`保存したときと別の場所で${w.label}が見つかりました。\n\n${hit.path}\n\nこのファイルを使いますか？`)) continue;
            try { found[w.kind] = { file: await hit.handle.getFile(), handle: hit.handle }; } catch { }
          }
        }
      }
    }
    if (found.lyric) lyricSrc = found.lyric;
    if (found.bg) bgSrc = found.bg;

    // ---- 歌詞動画 ----
    if (lyricSrc && !(lyric && lyric.name === lyricSrc.file.name && lyric.file.size === lyricSrc.file.size && lyric.file.lastModified === lyricSrc.file.lastModified)) {
      await loadLyric(lyricSrc.file, lyricSrc.handle);
    } else if (lyricSrc && lyric && !lyricHandle) lyricHandle = lyricSrc.handle;
    if (!lyric) {
      alert(`先に歌詞動画を登録してください。\n保存したときの歌詞動画：${proj.lyricName || '（不明）'}\n\n区間ファイルといっしょに動画も選ぶ（または落とす）と、まとめて登録できます。`);
      return;
    }
    const notes = [];
    if (proj.lyricName && lyric.name.toLowerCase() !== proj.lyricName.toLowerCase())
      notes.push(`保存したときの歌詞動画は「${proj.lyricName}」です（今は「${lyric.name}」）。`);
    // ---- 背景 ----
    if (bgSrc) {
      if (isImageFile(bgSrc.file)) el.rbBgImage.checked = true; else el.rbBgVideo.checked = true;
      if (!bg || bg.name !== bgSrc.file.name || bg.file.size !== bgSrc.file.size || bg.file.lastModified !== bgSrc.file.lastModified)
        await loadBackground(bgSrc.file, bgSrc.handle);
    } else if (proj.backgroundName && !isCurrent(bg, proj.backgroundName)) {
      notes.push(`保存したときの背景「${proj.backgroundName}」はセットできなかったので、背景は今のままにします。`);
    }
    // ---- ③ 調整（全体）の値 ----
    if (proj.global) applyGlobalSettings(proj.global);
    // ---- 区間 ----
    closeSegDialog(false);
    segments.length = 0;
    segments.push(...proj.segments);
    selectedSeg = null;
    markStart = markEnd = null;
    segmentsDirty = false;
    projectId = proj.webFileId || '';
    // 今の歌詞動画・背景の場所で記録を新しくする（確認して使うことにしたファイルを、次からは確認なしで開けるように）
    if (projectId && FileStore.supported() && lyricHandle && lyric && lyric.name.toLowerCase() === (proj.lyricName || '').toLowerCase()) {
      const bgOk = bg && bgHandle && bg.name.toLowerCase() === (proj.backgroundName || '').toLowerCase();
      FileStore.put(projectId, {
        lyric: lyricHandle, lyricInfo: FileStore.fileInfo(lyric.file),
        bg: bgOk ? bgHandle : (rec && rec.bg) || null, bgInfo: bgOk ? FileStore.fileInfo(bg.file) : (rec && rec.bgInfo) || null,
        backgroundIsVideo: el.rbBgVideo.checked,
      }).catch(() => { });
    }
    onSegmentsChanged(false);
    seekTo(0);
    if (notes.length) alert(notes.join('\n\n'));
  }

  /**
   * 覚えておいた場所から開く。読み取りの許可がなければ、ボタンを押してもらってから許可を求める。
   * 保存したときとファイルの中身（大きさ・更新日時）が変わっていたら確認する。
   * 戻り値：{ lyric?: {file, handle}, bg?: {file, handle} }（使わないことにしたものは w.declined = true）
   */
  async function openRecorded(list) {
    const out = {};
    // 許可が必要なものがあれば、ボタンを押してもらう（ブラウザの決まりで、ボタンを押した直後でないと許可を求められない）
    let needs = [];
    for (const w of list) if ((await FileStore.queryRead(w.rh)) !== 'granted') needs.push(w);
    for (let tries = 0; needs.length && tries < 3; tries++) {
      const names = needs.map(w => `・${w.label}：${w.name}`).join('\n');
      const ans = await askButtons(
        `保存したときの歌詞動画・背景を、覚えておいた場所から読み込みます。\n\n${names}\n\n` +
        '「読み込む」を押すと、ブラウザに「ファイルの表示を許可しますか？」と出るので、「許可」（「ファイルを表示する」）を押してください。',
        [{ label: '読み込む', value: 'ok', bold: true }, { label: 'やめる', value: 'no' }], '歌詞動画・背景を読み込む');
      if (ans !== 'ok') { for (const w of needs) w.declined = true; break; }
      const still = [];
      for (const w of needs) if ((await FileStore.requestRead(w.rh)) !== 'granted') still.push(w);
      needs = still;
    }
    for (const w of list) {
      if (w.declined || (await FileStore.queryRead(w.rh)) !== 'granted') { w.declined = true; continue; }
      let file;
      try { file = await w.rh.getFile(); }
      catch { continue; }            // 見つからない（移動・削除・名前の変更）→ フォルダーから探す
      if (w.info && !FileStore.sameInfo(w.info, FileStore.fileInfo(file))) {
        const fmt = i => `${i.name}（${(i.size / 1048576).toFixed(1)} MB、${new Date(i.lastModified).toLocaleString('ja-JP')} 更新）`;
        if (!confirm(`保存したときから${w.label}が変わっているようです。\n\n保存したとき：${fmt(w.info)}\n今：${fmt(FileStore.fileInfo(file))}\n\nこのファイルを使いますか？`)) {
          w.declined = true;
          continue;
        }
      }
      out[w.kind] = { file, handle: w.rh };
    }
    return out;
  }

  /** ボタンを選んでもらう小さな窓。押されたボタンの value を返す */
  function askButtons(message, buttons, title = '確認') {
    return new Promise(resolve => {
      const dlg = $('askDialog');
      $('askTitle').textContent = title;
      $('askMsg').textContent = message;
      const row = $('askBtns');
      row.innerHTML = '<span class="spacer"></span>';
      for (const b of buttons) {
        const btn = document.createElement('button');
        btn.textContent = b.label;
        if (b.bold) btn.className = 'bold';
        btn.addEventListener('click', () => { dlg.hidden = true; resolve(b.value); });
        row.appendChild(btn);
      }
      dlg.hidden = false;
      const first = row.querySelector('button.bold') || row.querySelector('button');
      if (first) first.focus();
    });
  }

  function confirmDiscardSegments() {
    if (!segmentsDirty || !segments.length) return true;
    return confirm('区間の変更が保存されていません。保存せずに続けますか？\n（保存する場合は「キャンセル」を押してから「区間保存」を押してください）');
  }
  window.addEventListener('beforeunload', e => {
    if ((segmentsDirty && segments.length) || exporting) { e.preventDefault(); e.returnValue = ''; }
  });

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // ------------------------------------------------------------------
  // 書き出し
  // ------------------------------------------------------------------
  el.txtOut.addEventListener('input', () => { el.txtOut.dataset.edited = '1'; });
  el.btnExport.addEventListener('click', startExport);
  el.btnCancel.addEventListener('click', () => {
    if (exportAbort) { exportAbort.aborted = true; el.btnCancel.disabled = true; el.lblStatus.textContent = '中止しています...'; }
  });

  const MP4_AUDIO = ['aac', 'mp3', 'opus', 'flac', 'ac3', 'eac3', 'vorbis'];

  /**
   * 歌詞動画と同じフォルダーに、書き出し用のファイルを作る。
   * フォルダーは、最初の 1 回だけ選んで書き込みを許可してもらい、このブラウザに覚えておく。
   * 戻り値：{ fileHandle, writable, name, dir } / null（やめた）/ undefined（この方法が使えない → 保存の画面で選ぶ）
   */
  async function openOutputInLyricFolder(name) {
    if (!lyricHandle || !window.showDirectoryPicker || !FileStore.supported()) return undefined;
    let dir = await FileStore.findDirOf(lyricHandle);
    if (dir) {
      // 覚えているフォルダー：書き込みの許可を確かめる（ブラウザを開き直したあとは確認が出る）
      if ((await FileStore.queryWrite(dir)) !== 'granted' && (await FileStore.requestWrite(dir)) !== 'granted') {
        const ans = await askButtons(
          `歌詞動画のフォルダー「${dir.name}」に書き出します。\n\n「書き出す」を押すと、ブラウザに書き込みを許可するかの確認が出るので、「変更を保存」（「許可」）を押してください。`,
          [{ label: '書き出す', value: 'ok', bold: true }, { label: '保存先を選ぶ', value: 'pick' }, { label: 'やめる', value: 'no' }], '書き出し');
        if (ans === 'pick') return undefined;
        if (ans !== 'ok') return null;
        if ((await FileStore.requestWrite(dir)) !== 'granted') {
          alert('フォルダーへの書き込みが許可されなかったので、保存先を選んでください。');
          return undefined;
        }
      }
    } else {
      // まだ覚えていないフォルダー：最初の 1 回だけ選んでもらう
      const ans = await askButtons(
        '歌詞動画と同じフォルダーに書き出せるように、このフォルダーについて最初の 1 回だけ確認します。\n\n' +
        '「フォルダーを確認」を押すと、歌詞動画のフォルダーが開いた状態で「フォルダーの選択」の画面が出ます。そのまま「フォルダーの選択」を押し、次に出る確認で「変更を保存」（「許可」）を押してください。\n\n' +
        '次からは、このフォルダーの歌詞動画は確認なしで書き出します。',
        [{ label: 'フォルダーを確認', value: 'ok', bold: true }, { label: '保存先を選ぶ', value: 'pick' }, { label: 'やめる', value: 'no' }], '書き出し先のフォルダー');
      if (ans === 'pick') return undefined;
      if (ans !== 'ok') return null;
      try { dir = await window.showDirectoryPicker({ mode: 'readwrite', startIn: lyricHandle }); }
      catch (e) { return e && e.name === 'AbortError' ? null : undefined; }
      if (!(await FileStore.isDirectChild(dir, lyricHandle)) &&
          !confirm(`選んだフォルダー「${dir.name}」には、歌詞動画「${lyric.name}」が入っていません。\nこのフォルダーに書き出しますか？`)) return null;
      if ((await FileStore.queryWrite(dir)) !== 'granted' && (await FileStore.requestWrite(dir)) !== 'granted') {
        alert('フォルダーへの書き込みが許可されなかったので、保存先を選んでください。');
        return undefined;
      }
      try { await FileStore.addDir(dir); } catch { }
    }
    // 同じ名前のファイルがあれば、上書きせずに番号を付ける（○○ (2).mp4）
    const base = name.replace(/\.mp4$/i, '');
    const existing = new Set();
    for await (const key of dir.keys()) existing.add(key.toLowerCase());
    let n = name;
    for (let k = 2; existing.has(n.toLowerCase()) && k < 10000; k++) n = `${base} (${k}).mp4`;
    const fileHandle = await dir.getFileHandle(n, { create: true });
    const writable = await fileHandle.createWritable();
    return { fileHandle, writable, name: n, dir };
  }

  // ---- 書き出し中は画面が自動で消えないようにする（Screen Wake Lock）----
  // 画面が消えたり、ほかのアプリに切り替えたりすると、ブラウザが処理を止めて書き出しが途中で終わるため
  let wakeLock = null, wakeWanted = false, exportNoticeTimer = 0;
  async function acquireWakeLock() {
    if (!wakeWanted || wakeLock || document.visibilityState !== 'visible') return !!wakeLock;
    try {
      if (!('wakeLock' in navigator)) return false;
      const lock = await navigator.wakeLock.request('screen');
      if (!wakeWanted) { try { await lock.release(); } catch { } return false; }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      return true;
    } catch { return false; }
  }
  async function releaseWakeLock() {
    wakeWanted = false;
    const lock = wakeLock; wakeLock = null;
    if (lock) { try { await lock.release(); } catch { } }
  }
  // 裏に回ると自動で外れるので、戻ってきたらかけ直す
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeWanted) acquireWakeLock().then(updateExportNotice);
  });
  function updateExportNotice() {
    const n = $('exportNotice');
    if (!exporting) { n.hidden = true; return; }
    n.hidden = false;
    const pct = Math.floor((el.progress.value || 0) / 10);
    $('exportNoticePct').textContent = pct + '%';
    $('exportNoticeLock').textContent = wakeLock
      ? '書き出しが終わるまで、画面は自動では消えません。'
      : 'この端末では画面が自動で消えるのを止められませんでした。終わるまで、ときどき画面に触れてください。';
  }
  function showExportNotice(on) {
    clearInterval(exportNoticeTimer);
    if (on) exportNoticeTimer = setInterval(updateExportNotice, 500);
    updateExportNotice();
  }

  async function startExport() {
    if (exporting || !lyric) return;
    if (!bg) { alert('② 背景を選んでください。'); return; }
    if (!window.VideoEncoder) { alert('このブラウザは動画の書き出しに対応していません。Google Chrome か Microsoft Edge でお使いください。'); return; }
    let name = el.txtOut.value.trim() || (lyric.name.replace(/\.[^.]+$/, '') + '_合成.mp4');
    if (!/\.mp4$/i.test(name)) name += '.mp4';
    const [W, H] = outSize();
    const quality = [MB.QUALITY_VERY_HIGH, MB.QUALITY_HIGH, MB.QUALITY_MEDIUM][+el.cmbQuality.value] || MB.QUALITY_HIGH;
    try {
      if (!(await MB.canEncodeVideo('avc', { width: W, height: H, bitrate: quality })))
        throw new Error('');
    } catch {
      alert(`このブラウザでは ${W}×${H} の H.264 動画を書き出せません。`);
      return;
    }

    // 保存先：歌詞動画と同じフォルダーへ直接書き込む。できないとき・オフのときは保存の画面で選ぶ。
    //         （保存の画面が使えないブラウザでは、最後にダウンロード）
    let fileHandle = null, writable = null, outDir = null, where = '';
    if (el.chkOutSameDir.checked) {
      const r = await openOutputInLyricFolder(name);
      if (r === null) return;                       // やめた
      if (r) {
        fileHandle = r.fileHandle; writable = r.writable; name = r.name; outDir = r.dir;
        where = r.dir.name + '\\';
      }
    }
    if (!writable && window.showSaveFilePicker) {
      try {
        const opts = { suggestedName: name, types: [{ description: 'MP4 動画', accept: { 'video/mp4': ['.mp4'] } }] };
        if (lyricHandle) opts.startIn = lyricHandle;          // 保存の画面は歌詞動画のフォルダーで開く
        fileHandle = await window.showSaveFilePicker(opts);
        writable = await fileHandle.createWritable();
        name = fileHandle.name;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        fileHandle = null; writable = null;
      }
    }

    stopPlayback(false);
    exporting = true;
    const abort = exportAbort = { aborted: false };
    updateButtons();
    wakeWanted = true;
    acquireWakeLock().then(updateExportNotice);
    showExportNotice(true);
    el.progress.value = 0;
    el.lblStatus.textContent = '準備しています...';
    const startedAt = performance.now();
    const tl = new SegmentTimeline(segments, currentSettings());     // 書き出しを始めたときの設定で最後まで作る
    let output = null;
    let ok = false;
    try {
      const target = writable ? new MB.StreamTarget(writable, { chunked: true }) : new MB.BufferTarget();
      output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'reserve' }), target });
      const videoSource = new MB.VideoSampleSource({ codec: 'avc', bitrate: quality, sizeChangeBehavior: 'deny' });
      const frameTotal = lyric.frameCount;
      output.addVideoTrack(videoSource, { frameRate: fps(), maximumPacketCount: Math.ceil(frameTotal * 1.1) + 120 });

      // 音声は歌詞動画のものを、そのまま（作り直さずに）入れる
      let audioSource = null, audioTrack = lyric.audio;
      if (audioTrack) {
        if (MP4_AUDIO.includes(audioTrack.codec)) {
          audioSource = new MB.EncodedAudioPacketSource(audioTrack.codec);
          let count = 0;
          try { count = (await audioTrack.computePacketStats()).packetCount; } catch { }
          if (!count) count = Math.ceil(lyric.duration * 50);
          output.addAudioTrack(audioSource, { maximumPacketCount: Math.ceil(count * 1.05) + 100 });
        } else {
          toast(`歌詞動画の音声（${audioTrack.codec}）は MP4 に入れられないため、音声なしで書き出します。`, 8000);
          audioTrack = null;
        }
      }
      await output.start();

      const audioFirst = audioTrack ? await audioTrack.getFirstTimestamp() : Infinity;
      const shift = Math.min(lyric.firstTimestamp, audioFirst);

      const audioTask = (async () => {
        if (!audioTrack) return;
        const sink = new MB.EncodedPacketSink(audioTrack);
        const decoderConfig = await audioTrack.getDecoderConfig();
        let first = true;
        for await (const p of sink.packets()) {
          if (abort.aborted) return;
          const ts = p.timestamp - shift;
          if (ts < 0) continue;
          await audioSource.add(ts === p.timestamp ? p : p.clone({ timestamp: ts }), first ? { decoderConfig } : undefined);
          first = false;
        }
        audioSource.close();
      })();

      const videoTask = (async () => {
        const bReader = bg.isImage ? null : new SequentialReader(bg, 0, true);
        const bgImg = bg.isImage ? bgImageRgba(W, H) : null;
        const maxInFlight = EXPORT_WORKERS * 2;
        const q = [];
        let done = 0;
        const flushHead = async () => {
          const j = q.shift();
          const out = await j.job;
          const vs = new MB.VideoSample(out, { format: 'RGBA', codedWidth: W, codedHeight: H, timestamp: j.t, duration: j.dur });
          try { await videoSource.add(vs); } finally { vs.close(); }
          done++;
          const pr = Math.min(1, j.t / Math.max(0.001, lyric.duration));
          el.progress.value = Math.round(pr * 1000);
          const sec = (performance.now() - startedAt) / 1000;
          const speed = done / Math.max(0.001, sec);
          const remain = pr > 0.01 ? sec * (1 - pr) / pr : NaN;
          el.lblStatus.textContent = `書き出し中　${(pr * 100).toFixed(1)}%　${done} / 約${frameTotal} コマ　${speed.toFixed(1)} コマ/秒` +
            (isFinite(remain) ? `　残り約 ${fmtDuration(remain)}` : '');
        };
        try {
          for await (const s of lyric.sink.samples()) {
            if (abort.aborted) { s.close(); break; }
            const t = s.timestamp - shift;
            const dur = s.duration > 0 ? s.duration : 1 / fps();
            const fgSrc = await frameForWorker(s, W, H, 'fill');
            s.close();
            let bgSrc;
            if (bReader) {
              const b = await bReader.frameAt(s.timestamp - lyric.firstTimestamp + 1e-4);
              bgSrc = b ? await frameForWorker(b, W, H, 'cover') : { rgba: new ArrayBuffer(W * H * 4) };
            } else bgSrc = { rgba: bgImg.slice().buffer };
            const st = tl.at(s.timestamp - lyric.firstTimestamp);
            q.push({ t, dur, job: pool.processSrc(fgSrc, bgSrc, W, H, st, { key: 'export', reuse: 0, workers: EXPORT_WORKERS }) });
            while (q.length >= maxInFlight) await flushHead();
          }
          while (q.length && !abort.aborted) await flushHead();
        } finally {
          if (bReader) bReader.close();
          for (const j of q) j.job.catch(() => { });
        }
        videoSource.close();
      })();

      await Promise.all([videoTask, audioTask]);
      if (abort.aborted) throw new DOMException('中止', 'AbortError');
      el.lblStatus.textContent = '仕上げています...';
      await output.finalize();
      if (!writable) downloadBlob(new Blob([output.target.buffer], { type: 'video/mp4' }), name);
      ok = true;
      el.progress.value = 1000;
      const sec = (performance.now() - startedAt) / 1000;
      el.lblStatus.textContent = `完了しました（${fmtDuration(sec)}）　${where}${name}`;
    } catch (e) {
      try { if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel(); } catch { }
      try { if (writable) await writable.abort(); } catch { }
      if (abort.aborted || (e && e.name === 'AbortError')) {
        el.lblStatus.textContent = '中止しました';
        // 途中までのファイルは消す
        if (outDir) { try { await outDir.removeEntry(name); } catch { } }
        else if (fileHandle && fileHandle.remove) { try { await fileHandle.remove(); } catch { } }
      } else {
        el.lblStatus.textContent = 'エラーで止まりました';
        alert('書き出しできませんでした。\n' + (e && e.message || e));
      }
    } finally {
      pool.clear('export');
      exporting = false;
      exportAbort = null;
      releaseWakeLock();
      showExportNotice(false);
      updateButtons();
      if (ok) requestPreview(true);
    }
  }

  // ------------------------------------------------------------------
  // ボタンの使える・使えない
  // ------------------------------------------------------------------
  function updateButtons() {
    const idle = !exporting;
    const haveLyric = idle && !!lyric;
    el.btnExport.disabled = !(idle && lyric && bg);
    el.btnCancel.disabled = !exporting;
    el.btnPlay.disabled = !haveLyric;
    for (const b of [el.btnBackSec, el.btnBackFrame, el.btnFwdFrame, el.btnFwdSec]) b.disabled = !haveLyric;
    el.btnMarkStart.disabled = el.btnMarkEnd.disabled = !haveLyric;
    el.btnLoadSeg.disabled = !idle;
    el.btnAddSeg.disabled = !(haveLyric && markStart != null && markEnd != null && markEnd > markStart);
    el.btnEditSeg.disabled = el.btnDelSeg.disabled = !(haveLyric && selectedSeg);
    el.btnSaveSeg.disabled = !(haveLyric && segments.length);
    el.trkTime.disabled = !haveLyric;
    el.cmbPlaySize.disabled = !!player;
    el.chkGpu.disabled = !!player;
    for (const c of [el.btnLyric, el.btnBg, el.rbBgImage, el.rbBgVideo, el.trkKey, el.trkOutline, el.nudKey, el.nudOutline,
      el.trkNoise, el.nudNoise, el.cmbColor, el.colCustom, el.btnReset, el.btnSetBase, el.cmbQuality, el.txtOut, el.chkOutSameDir])
      c.disabled = !idle;
    if (typeof updateSpinButtons === 'function') updateSpinButtons();
  }

  // ------------------------------------------------------------------
  // 数値欄の ▼ ▲ ボタン（押し続けると連続で変わる）
  // ------------------------------------------------------------------
  const spinButtons = [];     // [ボタン, 数値欄]（使える・使えないを数値欄に合わせる）
  /**
   * 数値欄 nud の両側に ▼ ▲ を付ける。
   * stepFn(今の値, 向き +1/-1) → 新しい値。省略すると 1 ずつ（min～max の範囲）。
   * 値を変えたあと、数値欄の change を起こす（スライダーやプレビューはそこから更新される）。
   */
  function addSpin(nud, stepFn, after) {
    const wrap = document.createElement('span');
    wrap.className = 'spin';
    nud.parentNode.insertBefore(wrap, nud);
    const mk = (dir, text, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'spinBtn';
      b.textContent = text;
      b.title = title;
      b.tabIndex = -1;
      let timer = 0, held = false;
      const step = () => {
        const cur = +nud.value || 0;
        let v = stepFn ? stepFn(cur, dir) : cur + dir;
        if (nud.min !== '') v = Math.max(+nud.min, v);
        if (nud.max !== '') v = Math.min(+nud.max, v);
        if (String(v) === nud.value) return;
        nud.value = v;
        nud.dispatchEvent(new Event('change'));
        if (after) after(+nud.value);
      };
      const stop = () => { held = false; clearTimeout(timer); };
      b.addEventListener('pointerdown', e => {
        if (e.button !== 0 || b.disabled) return;
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        held = true;
        step();
        // 押し続けると、はじめはゆっくり、だんだん速く
        let delay = 380, count = 0;
        const again = () => {
          if (!held) return;
          step();
          count++;
          timer = setTimeout(again, count > 15 ? 25 : count > 5 ? 50 : 90);
        };
        timer = setTimeout(again, delay);
      });
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointercancel', stop);
      b.addEventListener('lostpointercapture', stop);
      spinButtons.push([b, nud]);
      return b;
    };
    wrap.append(mk(-1, '▼', '小さくする（押し続けると連続で変わります）'), nud, mk(+1, '▲', '大きくする（押し続けると連続で変わります）'));
  }
  // ③ 調整
  addSpin(el.nudKey); addSpin(el.nudOutline); addSpin(el.nudNoise);
  // 区間の設定
  addSpin(el.sdNudKey); addSpin(el.sdNudOutline); addSpin(el.sdNudNoise);
  // 区間の始まり・終わり：1 コマずつ動かし、その位置をプレビューに表示する
  const frameStep = (v, dir) => Math.round((Math.round(v * fps()) + dir) / fps() * 100) / 100;
  addSpin(el.sdStart, frameStep, v => seekTo(v));
  addSpin(el.sdEnd, frameStep, v => seekTo(v));
  for (const [b, nud] of spinButtons) {
    if (nud === el.sdStart) b.title = b.textContent === '▼' ? '1 コマ前にする（押し続けると連続）' : '1 コマ後にする（押し続けると連続）';
    if (nud === el.sdEnd) b.title = b.textContent === '▼' ? '1 コマ前にする（押し続けると連続）' : '1 コマ後にする（押し続けると連続）';
  }
  function updateSpinButtons() { for (const [b, nud] of spinButtons) b.disabled = nud.disabled; }

  // ------------------------------------------------------------------
  // スマホ・タブレット用の配置
  //   縦向き：上にプレビュー（固定）、下に操作と設定
  //   横向き：左にプレビュー、右に設定
  //   設定の ①～④ はタップで開いたり閉じたりできる
  // ------------------------------------------------------------------
  const groups = [el.grpLyric, el.grpBg, $('grpAdjust'), $('grpExport')];
  const groupKeys = ['lyric', 'bg', 'adjust', 'export'];
  const collapsedPref = Object.assign({ lyric: false, bg: false, adjust: false, export: true }, prefs.Collapsed || {});
  groups.forEach((g, i) => {
    g.classList.toggle('collapsed', !!collapsedPref[groupKeys[i]]);
    g.querySelector('h2').addEventListener('click', () => {
      if (!document.body.classList.contains('mobile')) return;
      g.classList.toggle('collapsed');
      collapsedPref[groupKeys[i]] = g.classList.contains('collapsed');
      prefs.Collapsed = collapsedPref;
      savePrefsSoon();
    });
  });

  /** 閉じた欄の見出しに出す、今の値のまとめ */
  function updateSummaries() {
    $('sumLyric').textContent = lyric ? lyric.name : '未選択';
    $('sumBg').textContent = bg ? bg.name : '未選択';
    $('sumAdjust').textContent = `抜き具合 ${el.trkKey.value}・縁取り ${el.trkOutline.value}・粒 ${el.trkNoise.value}`;
    $('sumExport').textContent = el.cmbQuality.selectedOptions[0] ? el.cmbQuality.selectedOptions[0].text.replace(/（.*/, '') : '';
  }
  for (const c of [el.trkKey, el.trkOutline, el.trkNoise, el.nudKey, el.nudOutline, el.nudNoise, el.cmbQuality])
    c.addEventListener(c.tagName === 'SELECT' ? 'change' : 'input', updateSummaries);
  for (const c of [el.nudKey, el.nudOutline, el.nudNoise]) c.addEventListener('change', updateSummaries);

  // ---- プレビューの回転 ----
  // 3 段のとき：回転ボタンで 右（90°）→ 左（-90°）→ 回さない。縦長・横長の動画で別々に覚える（縦長は右がはじめの設定）
  // 全画面（スマホ）のとき：回したほうが大きく映るなら自動で回す（向きはボタンで最後に選んだ向き）
  // 回すのは画面の表示だけで、書き出す動画の向きは変わらない
  const btnRotate = $('btnRotate');
  function isTallVideo() { return lyric && lyric.height > lyric.width; }
  function splitRotation() {
    if (!lyric) return 0;
    const v = isTallVideo() ? prefs.RotTall : prefs.RotWide;
    return v === 90 || v === -90 || v === 0 ? v : (isTallVideo() ? 90 : 0);
  }
  function previewRotation() {
    if (!lyric) return 0;
    const b = document.body.classList;
    if (b.contains('full')) {
      if (!b.contains('mobile')) return 0;
      const W = el.previewHost.clientWidth, H = el.previewHost.clientHeight;
      const vw = lyric.width, vh = lyric.height;
      const keep = Math.min(W / vw, H / vh), turn = Math.min(W / vh, H / vw);
      if (turn <= keep * 1.05) return 0;
      return prefs.RotDir === -90 ? -90 : 90;
    }
    return b.contains('split') ? splitRotation() : 0;
  }
  function fitPreview() {
    const rot = previewRotation();
    for (const c of [el.preview, $('previewGL')]) {
      if (!rot || !lyric) {
        c.classList.remove('rot');
        c.style.width = c.style.height = c.style.transform = '';
        continue;
      }
      // 回したあとに枠へ収まるように、縦横を入れ替えた枠に合わせて大きさを決める
      const W = el.previewHost.clientHeight, H = el.previewHost.clientWidth;
      const s = Math.min(W / lyric.width, H / lyric.height);
      c.classList.add('rot');
      c.style.width = Math.floor(lyric.width * s) + 'px';
      c.style.height = Math.floor(lyric.height * s) + 'px';
      c.style.transform = `rotate(${rot}deg)`;
    }
    const r = splitRotation();
    btnRotate.textContent = r === 90 ? '⟳ 右に回転中' : r === -90 ? '⟲ 左に回転中' : '⟳ 回さない';
  }
  btnRotate.addEventListener('click', e => {
    e.stopPropagation();
    if (!lyric) return;
    const next = { 90: -90, '-90': 0, 0: 90 }[splitRotation()];
    if (isTallVideo()) prefs.RotTall = next; else prefs.RotWide = next;
    if (next) prefs.RotDir = next;
    savePrefs();
    fitPreview();
  });
  for (const ev of ['dblclick', 'pointerdown']) btnRotate.addEventListener(ev, e => e.stopPropagation());
  if (window.ResizeObserver) new ResizeObserver(() => fitPreview()).observe(el.previewHost);

  function updateLayout() {
    const w = window.innerWidth, h = window.innerHeight;
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    const mobile = w < 900 || (coarse && Math.min(w, h) < 600);
    const landscape = w > h;
    // スマホの縦向きで「区間の設定」を開いている間だけ 3 段に分ける（別の窓に出しているときは分けない）
    const split = mobile && !landscape && !el.segDialog.hidden && !el.segDialog.classList.contains('inPip');
    document.body.classList.toggle('mobile', mobile);
    document.body.classList.toggle('landscape', mobile && landscape);
    document.body.classList.toggle('split', split);
    if (mobile && !split) {
      // プレビューの高さ（3 段のときは CSS で画面の 1/3 に固定するので、ここでは決めない）：歌詞動画の縦横比に合わせて、入るかぎり大きく（3 段のときは中段・下段の場所を残す）
      const a = lyric ? lyric.width / lyric.height : 16 / 9;
      const pw = landscape ? w * 0.6 : w;
      const maxH = landscape ? h * 0.8 : h * (a < 1 ? 0.62 : 0.45);
      document.body.style.setProperty('--pvh', Math.round(Math.max(120, Math.min(pw / a, maxH))) + 'px');
    }
    // 区間の設定の置き場所：3 段のときは下段（設定の欄）のいちばん上、それ以外は画面の上に浮かべる
    const dlg = el.segDialog;
    if (!dlg.classList.contains('inPip')) {
      const want = split ? $('left') : document.body;
      if (dlg.parentNode !== want) {
        if (split) want.prepend(dlg); else want.append(dlg);
      }
    }
    el.btnFull.textContent = document.body.classList.contains('full') ? (mobile ? '全画面を終了' : '全画面を終了（Esc）') : (mobile ? '⛶ 全画面' : '⛶ 全画面（F11）');
    drawSegBar();
    fitPreview();
  }
  window.addEventListener('resize', updateLayout);
  // 区間の設定を開く・閉じる・別の窓に出す・戻すたびに、3 段にするかどうかを決め直す
  new MutationObserver(() => updateLayout()).observe(el.segDialog, { attributes: true, attributeFilter: ['hidden', 'class'] });
  window.addEventListener('orientationchange', () => setTimeout(updateLayout, 200));

  // スマホなどで使えない機能は隠す
  if (!window.documentPictureInPicture) sdPopout.hidden = true;
  if (!window.showDirectoryPicker) $('rowOutSameDir').hidden = true;

  // ------------------------------------------------------------------
  // このアプリについて・動作環境
  // ------------------------------------------------------------------
  function openHelp(anchor = '') { window.open('help.html' + anchor, '_blank', 'noopener'); }
  $('btnHelp').addEventListener('click', () => openHelp());

  el.lnkAbout.addEventListener('click', e => { e.preventDefault(); el.aboutDialog.hidden = false; });
  el.aboutClose.addEventListener('click', () => { el.aboutDialog.hidden = true; });

  function checkEnvironment() {
    const missing = [];
    if (!window.VideoDecoder || !window.VideoEncoder) missing.push('WebCodecs');
    if (!window.OffscreenCanvas) missing.push('OffscreenCanvas');
    el.lblEnv.textContent = `計算スレッド ${pool.size}`;
    if (missing.length)
      showMsg('このブラウザでは動きません（' + missing.join('・') + ' が使えません）。\nGoogle Chrome か Microsoft Edge の最新版でお使いください。');
  }

  // ------------------------------------------------------------------
  // 起動
  // ------------------------------------------------------------------
  function applySavedPrefs() {
    const p = prefs;
    if (p.KeyThreshold != null) setSlider(el.trkKey, el.nudKey, p.KeyThreshold);
    if (p.OutlineRadius != null) setSlider(el.trkOutline, el.nudOutline, p.OutlineRadius);
    if (p.NoiseSize != null) setSlider(el.trkNoise, el.nudNoise, p.NoiseSize);
    if (Array.isArray(p.CustomColor)) { customColor = p.CustomColor; el.colCustom.value = hex(customColor); }
    if (p.OutlineMode != null) el.cmbColor.value = String(clamp(p.OutlineMode, 0, 4));
    if (p.QualityIndex != null) el.cmbQuality.value = String(clamp(p.QualityIndex, 0, 2));
    if (p.BackgroundIsVideo) el.rbBgVideo.checked = true;
    if (p.PlayQuality != null) el.cmbPlaySize.value = String(clamp(p.PlayQuality, 0, 5));
    if (p.PlaySound != null) el.chkSound.checked = !!p.PlaySound;
    if (p.Volume != null) el.trkVolume.value = clamp(p.Volume, 0, 100);
    if (p.OutSameDir != null) el.chkOutSameDir.checked = !!p.OutSameDir;
    if (p.UseGpu != null) el.chkGpu.checked = !!p.UseGpu;
    applyVolume();
  }

  applySavedPrefs();
  updateLayout();
  updateSummaries();
  updateBaseTooltip();
  rebuildTimeline();
  refreshSegmentUi();
  updateTime();
  updateButtons();
  checkEnvironment();

  // 動作確認用（開発者ツールから使える）
  window.__app = { get lyric() { return lyric; }, get bg() { return bg; }, loadLyric, loadBackground, seekTo, stepFrames, get curTime() { return curTime; }, startExport, loadSegmentsFromFiles, pool };
})();
