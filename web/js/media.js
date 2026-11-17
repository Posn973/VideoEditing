// 動画・画像の読み込み（Mediabunny と WebCodecs を使い、すべてこのパソコンの中で処理する）
(function () {
  'use strict';
  const MB = self.Mediabunny;

  const IMAGE_EXT = /\.(png|jpe?g|bmp|gif|webp|avif)$/i;
  const isImageFile = f => (f.type && f.type.startsWith('image/')) || IMAGE_EXT.test(f.name);

  function makeCanvas(w, h) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = c.getContext('2d', { willReadFrequently: true, alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return { canvas: c, ctx };
  }

  /** 画像を w×h に描く（fill = 引き伸ばす、cover = はみ出す分を切り取って全体を埋める） */
  function drawFit(ctx, src, sw, sh, w, h, fit) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    if (fit === 'cover') {
      const s = Math.max(w / sw, h / sh);
      const cw = w / s, ch = h / s;
      ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, w, h);
    } else {
      ctx.drawImage(src, 0, 0, sw, sh, 0, 0, w, h);
    }
  }

  const surfaces = new Map();
  function surface(w, h) {
    const key = w + 'x' + h;
    let s = surfaces.get(key);
    if (!s) { s = makeCanvas(w, h); surfaces.set(key, s); if (surfaces.size > 6) surfaces.delete(surfaces.keys().next().value); }
    return s;
  }

  /** VideoSample を w×h の RGBA にする */
  function sampleToRgba(sample, w, h, fit) {
    const { ctx } = surface(w, h);
    const src = sample.toCanvasImageSource();
    drawFit(ctx, src, sample.displayWidth, sample.displayHeight, w, h, fit);
    return ctx.getImageData(0, 0, w, h).data;
  }

  /**
   * VideoSample を Worker に渡せる形にする（YUV のデータをコピー）。
   * 動画の読み込み側のメモリ（デコーダーのコマ）をすぐ返せて、大きさの変更などの重い処理は Worker で行える。
   * 呼び出した側で sample を close() すること。
   */
  async function frameForWorker(sample, w, h, fit, quality = 'high') {
    // 再生中（quality が high 以外）：ブラウザの機能で先に w×h へ縮小した画像（ImageBitmap）を渡す。
    // 元の大きさのデータをコピーしないので速い（スマホで特に効く）
    if (quality !== 'high' && typeof createImageBitmap === 'function') {
      let vf = null;
      try {
        vf = sample.toVideoFrame();
        const sw = vf.displayWidth, sh = vf.displayHeight;
        let sx = 0, sy = 0, cw = sw, ch = sh;
        if (fit === 'cover') {
          const k = Math.max(w / sw, h / sh);
          cw = w / k; ch = h / k; sx = (sw - cw) / 2; sy = (sh - ch) / 2;
        }
        const bmp = await createImageBitmap(vf, Math.round(sx), Math.round(sy), Math.round(cw), Math.round(ch),
          { resizeWidth: w, resizeHeight: h, resizeQuality: quality === 'low' ? 'low' : 'medium' });
        return { bitmap: bmp };
      } catch { /* 下の方法で */ }
      finally { if (vf) vf.close(); }
    }
    const vf = sample.toVideoFrame();
    try {
      if (vf.format) {
        const buf = new Uint8Array(vf.allocationSize());
        const layout = await vf.copyTo(buf);
        // copyTo は見える部分（visibleRect）だけを詰めてコピーするので、その大きさで作り直す
        const r = vf.visibleRect;
        return {
          fit, quality, buf: buf.buffer,
          meta: {
            format: vf.format, codedWidth: r.width, codedHeight: r.height, layout,
            displayWidth: vf.displayWidth, displayHeight: vf.displayHeight,
            timestamp: vf.timestamp, colorSpace: vf.colorSpace.toJSON ? vf.colorSpace.toJSON() : undefined,
          },
        };
      }
    } catch { /* 下の方法で変換する */ }
    finally { vf.close(); }
    // コピーできない形式のときは、ここで RGBA にする
    return { rgba: sampleToRgba(sample, w, h, fit).slice().buffer };
  }

  class MediaFile {
    static async open(file) {
      const m = new MediaFile();
      m.file = file;
      m.name = file.name;
      if (isImageFile(file)) {
        m.isImage = true;
        try { m.bitmap = await createImageBitmap(file); }
        catch { throw new Error('画像を読み込めませんでした。'); }
        m.width = m.bitmap.width; m.height = m.bitmap.height;
        m.duration = 0; m.fps = 0; m.hasAudio = false;
        return m;
      }
      m.isImage = false;
      m.input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(file) });
      let vt;
      try { vt = await m.input.getPrimaryVideoTrack(); }
      catch { throw new Error('動画として読み込めませんでした。MP4 などの動画ファイルを選んでください。'); }
      if (!vt) throw new Error('映像が入っていないファイルです。');
      if (!(await vt.canDecode())) throw new Error(`このブラウザではこの映像形式（${vt.codec || '不明'}）を再生できません。`);
      m.video = vt;
      m.width = vt.displayWidth || vt.squarePixelWidth || vt.codedWidth;
      m.height = vt.displayHeight || vt.squarePixelHeight || vt.codedHeight;
      const rot = vt.rotation || 0;
      if (rot === 90 || rot === 270) [m.width, m.height] = [m.height, m.width];
      m.duration = await m.input.computeDuration();
      m.firstTimestamp = await vt.getFirstTimestamp();
      try {
        const st = await vt.computePacketStats(120);
        m.fps = st.averagePacketRate > 0 ? st.averagePacketRate : 30;
      } catch { m.fps = 30; }
      // 29.97 などはきれいな値にそろえる
      for (const std of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) if (Math.abs(m.fps - std) < 0.02) m.fps = std;
      m.audio = await m.input.getPrimaryAudioTrack();
      m.hasAudio = !!m.audio;
      m.sink = new MB.VideoSampleSink(vt);
      return m;
    }

    get frameCount() { return this.isImage ? 1 : Math.max(1, Math.round(this.duration * this.fps)); }

    infoText() {
      const ar = (() => {
        const g = (a, b) => b ? g(b, a % b) : a;
        const d = g(this.width, this.height) || 1;
        return `${this.width / d}:${this.height / d}`;
      })();
      if (this.isImage) return `画像　${this.width}×${this.height}（${ar}）`;
      return `${this.width}×${this.height}（${ar}）　${+this.fps.toFixed(2)}fps　${fmtDuration(this.duration)}　音声${this.hasAudio ? 'あり' : 'なし'}`;
    }

    /** 画像を w×h（cover）にした RGBA */
    imageRgba(w, h) {
      const { ctx } = surface(w, h);
      drawFit(ctx, this.bitmap, this.width, this.height, w, h, 'cover');
      return ctx.getImageData(0, 0, w, h).data;
    }

    /** t 秒のコマ（その時刻に表示されているコマ）を返す。呼び出した側で close() する */
    async sampleAt(t) {
      const s = await this.sink.getSample(Math.max(this.firstTimestamp, this.firstTimestamp + t));
      return s;
    }

    dispose() {
      try { this.input && this.input.dispose(); } catch { }
      try { this.bitmap && this.bitmap.close(); } catch { }
    }
  }

  /**
   * 時刻が増えていく順にコマを取り出す（再生・書き出し用）。loop = 最後まで行ったら最初に戻る（背景動画）。
   * frameAt(t) は t 秒に表示されるコマを返す（同じコマを何度か返すこともある。close しないこと）。
   */
  class SequentialReader {
    constructor(media, startTime, loop) {
      this.m = media;
      this.loop = loop;
      this.offset = 0;              // ループした回数 × 長さ
      this.cur = null;              // 今のコマ
      this.next = null;             // 次のコマ
      const dur = media.duration;
      let st = startTime;
      if (loop && dur > 0.05) { this.offset = Math.floor(st / dur) * dur; st -= this.offset; }
      this.startLocal = st;
      this.it = media.sink.samples(media.firstTimestamp + st);
      this.done = false;
    }

    async _pull() {
      for (; ;) {
        const r = await this.it.next();
        if (!r.done) return r.value;
        if (!this.loop || this.m.duration <= 0.05) return null;
        this.offset += this.m.duration;
        this.it = this.m.sink.samples(this.m.firstTimestamp);
      }
    }
    _local(s) { return s.timestamp - this.m.firstTimestamp + this.offset; }

    async frameAt(t) {
      if (!this.cur) { this.cur = await this._pull(); if (!this.cur) return null; }
      if (!this.next && !this.done) { this.next = await this._pull(); if (!this.next) this.done = true; }
      while (this.next && this._local(this.next) <= t + 1e-6) {
        this.cur.close();
        this.cur = this.next;
        this.next = await this._pull();
        if (!this.next) this.done = true;
      }
      return this.cur;
    }

    close() {
      try { this.cur && this.cur.close(); } catch { }
      try { this.next && this.next.close(); } catch { }
      this.cur = this.next = null;
      try { this.it.return(); } catch { }
    }
  }

  function fmtDuration(sec) {
    sec = Math.max(0, sec);
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  self.Media = { MediaFile, SequentialReader, sampleToRgba, frameForWorker, isImageFile, fmtDuration };
})();
