// 区間（ここから～ここまで）と、その区間で使う調整値（Windows 版 Segments.cs と同じ考え方）
// 区間ファイル（JSON）は Windows 版と同じ形式なので、どちらで保存したものも読み込めます。
(function () {
  'use strict';
  const { OutlineColorMode, defaultSettings } = self.CompositorLib;

  const cloneSettings = s => ({ ...s });

  function contains(seg, t) { return t >= seg.Start - 1e-6 && t <= seg.End + 1e-6; }

  /** 縁取りの色（R, G, B）。自動のときは白として扱う（平均の計算用） */
  function fixedColor(s) {
    switch (s.OutlineMode) {
      case OutlineColorMode.Black: return [0, 0, 0];
      case OutlineColorMode.Plum: return [38, 18, 40];
      case OutlineColorMode.Custom: return [s.CustomR, s.CustomG, s.CustomB];
      default: return [255, 255, 255];
    }
  }

  /**
   * 区間の一覧から「この時刻ではどの調整値を使うか」を決める。
   * 区間の境目では、前後 BlendSeconds 秒をかけてなめらかに切り替える。
   */
  class SegmentTimeline {
    static BlendSeconds = 0.25;

    constructor(segments, globalSettings) {
      this.segs = segments.map(s => ({ Start: s.Start, End: s.End, Settings: cloneSettings(s.Settings) }))
        .sort((a, b) => a.Start - b.Start);
      this.global = cloneSettings(globalSettings);
    }

    raw(t) {
      for (const s of this.segs) if (contains(s, t)) return s.Settings;
      return this.global;
    }

    at(t) {
      if (this.segs.length === 0) return cloneSettings(this.global);
      const B = SegmentTimeline.BlendSeconds, Samples = 9;
      const a = t - B / 2, b = t + B / 2;
      let nearEdge = false;
      for (const s of this.segs)
        if ((s.Start > a && s.Start <= b) || (s.End >= a && s.End < b)) { nearEdge = true; break; }
      const center = this.raw(t);
      if (!nearEdge) return cloneSettings(center);

      // 境目の近く：前後の設定を平均して、少しずつ変わるようにする
      let key = 0, soft = 0, outline = 0, noise = 0, r = 0, g = 0, bl = 0;
      let allFixed = true;
      for (let i = 0; i < Samples; i++) {
        const s = this.raw(a + (b - a) * i / (Samples - 1));
        key += s.KeyThreshold; soft += s.KeySoftness; outline += s.OutlineRadius; noise += s.NoiseSize;
        if (s.OutlineMode === OutlineColorMode.Auto) allFixed = false;
        const [cr, cg, cb] = fixedColor(s);
        r += cr; g += cg; bl += cb;
      }
      const res = cloneSettings(center);
      res.KeyThreshold = key / Samples;
      res.KeySoftness = soft / Samples;
      res.OutlineRadius = outline / Samples;
      res.NoiseSize = noise / Samples;
      if (allFixed) {
        res.OutlineMode = OutlineColorMode.Custom;
        res.CustomR = Math.round(r / Samples);
        res.CustomG = Math.round(g / Samples);
        res.CustomB = Math.round(bl / Samples);
      }
      return res;
    }
  }

  const round4 = v => Math.round(v * 10000) / 10000;

  function settingsToJson(st, seg) {
    const o = {};
    if (seg) { o.Start = round4(seg.Start); o.End = round4(seg.End); }
    o.KeyThreshold = st.KeyThreshold;
    o.KeySoftness = st.KeySoftness;
    o.OutlineRadius = st.OutlineRadius;
    o.NoiseSize = st.NoiseSize;
    o.OutlineMode = st.OutlineMode;
    o.CustomR = st.CustomR;
    o.CustomG = st.CustomG;
    o.CustomB = st.CustomB;
    return o;
  }

  function num(e, name, fallback) {
    return e && typeof e[name] === 'number' && isFinite(e[name]) ? e[name] : fallback;
  }
  const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(v)));

  function readSettings(e) {
    const d = defaultSettings();
    return {
      KeyThreshold: num(e, 'KeyThreshold', d.KeyThreshold),
      KeySoftness: num(e, 'KeySoftness', d.KeySoftness),
      OutlineRadius: num(e, 'OutlineRadius', d.OutlineRadius),
      NoiseSize: num(e, 'NoiseSize', d.NoiseSize),
      OutlineMode: clampInt(num(e, 'OutlineMode', 0), 0, 4),
      CustomR: clampInt(num(e, 'CustomR', 255), 0, 255),
      CustomG: clampInt(num(e, 'CustomG', 255), 0, 255),
      CustomB: clampInt(num(e, 'CustomB', 255), 0, 255),
    };
  }

  /** 区間ファイルの中身を JSON 文字列にする（Windows 版と同じ項目・順番） */
  function saveProject(p) {
    const o = {
      Version: 2,
      LyricVideo: p.lyricName || '',
      LyricVideoPath: p.lyricName || '',   // ブラウザではフルパスが分からないので、ファイル名を入れる
      BackgroundPath: p.backgroundName || '',
      BackgroundIsVideo: !!p.backgroundIsVideo,
    };
    // Web 版だけが使う番号：このブラウザに覚えた歌詞動画・背景の場所と結びつける（Windows 版は読み飛ばす）
    if (p.webFileId) o.WebFileId = p.webFileId;
    if (p.global) o.Global = settingsToJson(p.global, null);
    o.Segments = [...p.segments].sort((a, b) => a.Start - b.Start).map(sg => settingsToJson(sg.Settings, sg));
    return JSON.stringify(o, null, 2);
  }

  /** 区間ファイル（JSON 文字列）を読む */
  function loadProject(text) {
    let root;
    try { root = JSON.parse(text.replace(/^﻿/, '')); }
    catch { throw new Error('区間ファイルの形式が正しくありません。'); }
    if (!root || !Array.isArray(root.Segments)) throw new Error('区間ファイルの形式が正しくありません。');
    const str = n => typeof root[n] === 'string' ? root[n] : '';
    const baseName = path => path.split(/[\\/]/).pop() || '';
    const p = {
      lyricName: baseName(str('LyricVideoPath') || str('LyricVideo')),
      lyricPath: str('LyricVideoPath') || str('LyricVideo'),
      backgroundName: baseName(str('BackgroundPath')),
      backgroundPath: str('BackgroundPath'),
      backgroundIsVideo: root.BackgroundIsVideo === true,
      webFileId: str('WebFileId'),
      global: root.Global && typeof root.Global === 'object' ? readSettings(root.Global) : null,
      segments: [],
    };
    for (const e of root.Segments) {
      const sg = { Start: num(e, 'Start', 0), End: num(e, 'End', 0), Settings: readSettings(e) };
      if (sg.End > sg.Start) p.segments.push(sg);
    }
    p.segments.sort((a, b) => a.Start - b.Start);
    return p;
  }

  self.Segments = { SegmentTimeline, contains, cloneSettings, saveProject, loadProject };
})();
