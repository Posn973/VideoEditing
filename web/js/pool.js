// 合成の計算を Web Worker（別のスレッド）で行う。複数の Worker で同時に処理して速くする。
// Worker のプログラムは compositor.js の関数を文字列にして作るので、
// index.html をダブルクリックで開いた場合（file://）でも動きます。
(function () {
  'use strict';

  function workerMain() {
    // ここは Worker の中で動く（createCompositorLib は前に連結される）
    const lib = createCompositorLib();
    const comps = new Map();
    let cv = null, cx = null;

    /** 受け取ったコマ（YUV のデータ、または RGBA）を w×h の RGBA にする。大きさの変更もここで行う */
    function toRgba(src, w, h) {
      if (!src) return null;
      if (src.rgba) return new Uint8ClampedArray(src.rgba);
      if (src.bitmap) {
        // もう w×h に縮小してある画像：描いて画素を取り出すだけ
        if (!cv || cv.width !== w || cv.height !== h) {
          cv = new OffscreenCanvas(w, h);
          cx = cv.getContext('2d', { willReadFrequently: true, alpha: false });
        }
        cx.drawImage(src.bitmap, 0, 0, w, h);
        src.bitmap.close();
        return cx.getImageData(0, 0, w, h).data;
      }
      const vf = new VideoFrame(src.buf, src.meta);
      try {
        if (!cv || cv.width !== w || cv.height !== h) {
          cv = new OffscreenCanvas(w, h);
          cx = cv.getContext('2d', { willReadFrequently: true, alpha: false });
        }
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = src.quality || 'high';   // 再生中は軽い方法、書き出しはきれいな方法で大きさを変える
        const sw = vf.displayWidth, sh = vf.displayHeight;
        cx.fillStyle = '#000';
        cx.fillRect(0, 0, w, h);
        if (src.fit === 'cover') {
          const k = Math.max(w / sw, h / sh), cw = w / k, ch = h / k;
          cx.drawImage(vf, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, w, h);
        } else {
          cx.drawImage(vf, 0, 0, sw, sh, 0, 0, w, h);
        }
        return cx.getImageData(0, 0, w, h).data;
      } finally { vf.close(); }
    }

    self.onmessage = e => {
      const m = e.data;
      if (m.type === 'clear') {               // 使い終わった計算用のメモリを手放す
        for (const k of [...comps.keys()]) if (k.startsWith(m.key + ':')) comps.delete(k);
        return;
      }
      if (m.type === 'estimate') {
        // 背景色の推定だけを行う（GPU で再生するとき用。小さく縮小したコマを受け取る）
        try {
          const t0 = performance.now();
          const fg = toRgba({ bitmap: m.bitmap }, m.w, m.h);
          const key = `${m.key}:${m.w}x${m.h}`;
          let c = comps.get(key);
          if (!c) { c = new lib.Compositor(m.w, m.h); comps.set(key, c); }
          c.backgroundReuseFrames = m.reuse | 0;
          c.estimateBackground(fg);
          const n = c.sw * c.sh, est = c.smEst, out = new Uint8ClampedArray(n * 4);
          for (let i = 0, j = 0, p = 0; i < n; i++, j += 3, p += 4) { out[p] = est[j]; out[p + 1] = est[j + 1]; out[p + 2] = est[j + 2]; out[p + 3] = 255; }
          self.postMessage({ id: m.id, out: out.buffer, sw: c.sw, sh: c.sh, conv: 0, comp: performance.now() - t0 }, [out.buffer]);
        } catch (err) {
          self.postMessage({ id: m.id, error: String(err && err.message || err) });
        }
        return;
      }
      try {
        const t0 = performance.now();
        const fg = toRgba(m.fg, m.w, m.h);
        const bg = m.mode === 'fg' ? null : toRgba(m.bg, m.w, m.h);
        const t1 = performance.now();
        let out;
        if (m.mode === 'fg') out = fg;
        else if (m.mode === 'bg') out = bg;
        else {
          const key = `${m.key}:${m.w}x${m.h}`;
          let c = comps.get(key);
          if (!c) {
            c = new lib.Compositor(m.w, m.h);
            comps.set(key, c);
            if (comps.size > 4) comps.delete(comps.keys().next().value);   // 古い大きさのものは捨てる
          }
          c.backgroundReuseFrames = m.reuse | 0;
          out = new Uint8ClampedArray(m.w * m.h * 4);
          c.process(fg, bg, out, m.settings);
        }
        const t2 = performance.now();
        if (out.byteLength !== out.buffer.byteLength) out = out.slice();
        self.postMessage({ id: m.id, out: out.buffer, conv: t1 - t0, comp: t2 - t1 }, [out.buffer]);
      } catch (err) {
        self.postMessage({ id: m.id, error: String(err && err.message || err) });
      }
    };
  }

  let workerUrl = null;
  function getWorkerUrl() {
    if (!workerUrl) {
      const src = `${createCompositorLib.toString()}\n(${workerMain.toString()})();`;
      workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    }
    return workerUrl;
  }

  class Worker1 {
    constructor() {
      this.w = new Worker(getWorkerUrl());
      this.busy = 0;
      this.jobs = new Map();
      this.w.onmessage = e => {
        const m = e.data;
        const job = this.jobs.get(m.id);
        if (!job) return;
        this.jobs.delete(m.id);
        this.busy--;
        if (m.error) job.reject(new Error(m.error));
        else {
          const out = new Uint8ClampedArray(m.out);
          out.timing = { conv: m.conv, comp: m.comp };     // かかった時間（再生の診断表示用）
          if (m.sw) { out.sw = m.sw; out.sh = m.sh; }
          job.resolve(out);
        }
      };
      this.w.onerror = e => {
        for (const j of this.jobs.values()) j.reject(new Error(e.message || '計算中にエラーが起きました'));
        this.jobs.clear();
        this.busy = 0;
      };
    }
  }

  let nextId = 1;

  class CompositorPool {
    constructor(size) {
      this.workers = [];
      this.size = Math.max(1, size);
    }
    ensure(count) {
      while (this.workers.length < Math.min(count, this.size)) this.workers.push(new Worker1());
    }
    /** key で作った計算用のメモリを、すべての Worker で手放す */
    clear(key) {
      for (const wk of this.workers) wk.w.postMessage({ type: 'clear', key });
    }
    /**
     * 合成する（fg・bg は RGBA の Uint8ClampedArray）。fg は手放す（中身が使えなくなる）、bg はコピーして送る。
     */
    process(fg, bg, w, h, settings, opts = {}) {
      const fgBuf = fg.buffer.byteLength === fg.byteLength ? fg.buffer : fg.slice().buffer;
      const bgSrc = bg ? { rgba: opts.transferBg ? bg.buffer : bg.slice().buffer } : null;
      return this.processSrc({ rgba: fgBuf }, bgSrc, w, h, settings, opts);
    }

    /** 背景色の推定だけを頼む（bitmap は w×h に縮小済み。w は 240 以下）。結果は sw×sh の RGBA */
    estimate(bitmap, w, h, opts = {}) {
      this.ensure(1);
      const wk = this.workers[0];      // 推定の使い回しを続けるため、いつも同じ Worker で
      const id = nextId++;
      return new Promise((resolve, reject) => {
        wk.jobs.set(id, { resolve, reject });
        wk.busy++;
        wk.w.postMessage({ type: 'estimate', id, w, h, bitmap, key: opts.key || 'est', reuse: opts.reuse || 0 }, [bitmap]);
      });
    }

    /**
     * 合成する。fgSrc・bgSrc は Media.frameForWorker() で作ったもの（YUV のデータ）か { rgba: ArrayBuffer }。
     * 大きさの変更（w×h）も Worker の中で行うので、画面側の処理が軽くなる。中のデータは手放す。
     * opts.mode: 'composite'（合成結果）/ 'fg'（歌詞動画だけ）/ 'bg'（背景だけ）
     * opts.workerIndex を指定すると、その Worker で計算する（背景色の推定の使い回しを同じ Worker で続けるため）。
     */
    processSrc(fgSrc, bgSrc, w, h, settings, opts = {}) {
      const count = opts.workers || this.size;
      this.ensure(count);
      const n = Math.min(count, this.workers.length);
      let wk;
      if (opts.workerIndex != null) wk = this.workers[opts.workerIndex % n];
      else {
        wk = this.workers[0];
        for (let i = 1; i < n; i++) if (this.workers[i].busy < wk.busy) wk = this.workers[i];
      }
      const id = nextId++;
      const transfer = [];
      for (const src of [fgSrc, bgSrc]) {
        if (!src) continue;
        const buf = src.rgba || src.buf || src.bitmap;
        if (buf && !transfer.includes(buf)) transfer.push(buf);
      }
      return new Promise((resolve, reject) => {
        wk.jobs.set(id, { resolve, reject });
        wk.busy++;
        wk.w.postMessage({
          id, w, h, settings, key: opts.key || 'still', reuse: opts.reuse || 0, mode: opts.mode || 'composite',
          fg: fgSrc, bg: bgSrc,
        }, transfer);
      });
    }
  }

  self.CompositorPool = CompositorPool;
})();
