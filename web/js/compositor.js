// 歌詞動画の 1 コマから背景を抜き、文字と効果だけを背景に重ねる（Windows 版 Compositor.cs と同じ計算）。
// フレームはすべて RGBA（1 画素 4 バイト、Canvas の ImageData と同じ並び）。
//
// この関数はそのまま文字列にして Web Worker の中でも動かすので、外の変数を使わないこと。
function createCompositorLib() {
  'use strict';

  const OutlineColorMode = { Auto: 0, White: 1, Black: 2, Plum: 3, Custom: 4 };

  function defaultSettings() {
    return {
      KeyThreshold: 83, KeySoftness: 33, OutlineRadius: 4, NoiseSize: 0,
      OutlineMode: OutlineColorMode.Auto, CustomR: 255, CustomG: 255, CustomB: 255,
    };
  }

  function gaussianKernel(sigma) {
    const size = (Math.round(sigma * 8 + 1)) | 1;   // OpenCV と同じ大きさ
    const k = new Float32Array(size);
    const c = size >> 1;
    let sum = 0;
    for (let i = 0; i < size; i++) {
      const v = Math.exp(-(i - c) * (i - c) / (2 * sigma * sigma));
      k[i] = v; sum += v;
    }
    for (let i = 0; i < size; i++) k[i] = k[i] / sum;
    return k;
  }
  const Kernel12 = gaussianKernel(12.0);
  const Kernel2 = gaussianKernel(2.0);

  function reflect101(i, len) {
    if (len === 1) return 0;
    while (i < 0 || i >= len) {
      if (i < 0) i = -i;
      if (i >= len) i = 2 * len - 2 - i;
    }
    return i;
  }

  const blurMaps = new Map();
  function blurMap(len, r) {
    const key = len * 1000 + r;
    let m = blurMaps.get(key);
    if (!m) {
      m = new Int32Array(len + 2 * r);
      for (let i = 0; i < m.length; i++) m[i] = reflect101(i - r, len);
      blurMaps.set(key, m);
    }
    return m;
  }

  /** ガウスぼかし（src と dst は同じ配列でもよい）。tmp は w*h 以上。
   *  ぼかしの重みは左右対称なので、対称な 2 つを先に足してから掛ける（掛け算が半分になる） */
  function blurPlane(src, dst, tmp, w, h, kernel) {
    const kl = kernel.length, r = kl >> 1;
    const cmap = blurMap(w, r), rmap = blurMap(h, r);
    const kc = kernel[r];

    // 0 でない画素がある範囲を調べる（歌詞は画面の一部なので、何もない所の計算を省く。結果は同じ）
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (src[row + x] !== 0) {
          if (y < y0) y0 = y;
          y1 = y;
          if (x < x0) x0 = x;
          // 行の右端の 0 でない画素
          let xe = w - 1;
          while (src[row + xe] === 0) xe--;
          if (xe > x1) x1 = xe;
          break;
        }
      }
    }
    if (y1 < 0) { dst.fill(0, 0, w * h); return; }
    // 結果が 0 でなくなりうる範囲（ぼかしの半径ぶん広げる）
    const ox0 = Math.max(0, x0 - r), ox1 = Math.min(w - 1, x1 + r);
    const oy0 = Math.max(0, y0 - r), oy1 = Math.min(h - 1, y1 + r);

    const pad = new Float32Array(w + 2 * r);
    // 横方向（0 でない画素がある行だけ。ほかの行は 0）
    for (let y = 0; y < h; y++) {
      const row = y * w;
      if (y < y0 || y > y1) { tmp.fill(0, row, row + w); continue; }
      for (let i = 0; i < pad.length; i++) pad[i] = src[row + cmap[i]];
      if (ox0 > 0) tmp.fill(0, row, row + ox0);
      if (ox1 < w - 1) tmp.fill(0, row + ox1 + 1, row + w);
      for (let x = ox0; x <= ox1; x++) {
        const c = x + r;
        let acc = pad[c] * kc;
        for (let k = 1; k <= r; k++) acc += (pad[c - k] + pad[c + k]) * kernel[r + k];
        tmp[row + x] = acc;
      }
    }
    // 縦方向
    const acc = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      if (y < oy0 || y > oy1) { dst.fill(0, y * w, y * w + w); continue; }
      const rc = rmap[y + r] * w;
      for (let x = ox0; x <= ox1; x++) acc[x] = tmp[rc + x] * kc;
      for (let k = 1; k <= r; k++) {
        const ra = rmap[y + r - k] * w, rb = rmap[y + r + k] * w, kv = kernel[r + k];
        for (let x = ox0; x <= ox1; x++) acc[x] += (tmp[ra + x] + tmp[rb + x]) * kv;
      }
      const row = y * w;
      if (ox0 > 0) dst.fill(0, row, row + ox0);
      if (ox1 < w - 1) dst.fill(0, row + ox1 + 1, row + w);
      for (let x = ox0; x <= ox1; x++) dst[row + x] = acc[x];
    }
  }

  function erode2x2(src, dst, w, h) {
    for (let y = 0; y < h; y++) {
      const row = y * w, up = (y > 0 ? y - 1 : y) * w;
      for (let x = 0; x < w; x++) {
        const xl = x > 0 ? x - 1 : x;
        let m = src[row + x];
        let v = src[row + xl]; if (v < m) m = v;
        v = src[up + x]; if (v < m) m = v;
        v = src[up + xl]; if (v < m) m = v;
        dst[row + x] = m;
      }
    }
  }

  function dilate2x2(src, dst, w, h) {
    for (let y = 0; y < h; y++) {
      const row = y * w, dn = (y < h - 1 ? y + 1 : y) * w;
      for (let x = 0; x < w; x++) {
        const xr = x < w - 1 ? x + 1 : x;
        let m = src[row + x];
        let v = src[row + xr]; if (v > m) m = v;
        v = src[dn + x]; if (v > m) m = v;
        v = src[dn + xr]; if (v > m) m = v;
        dst[row + x] = m;
      }
    }
  }

  const FAR = 1e9;
  /** マスク（値 1 の画素）までのユークリッド距離。maxR より遠い画素は「とても遠い」 */
  function distanceTransform(mask, outDist, g, w, h, maxR) {
    // 縦方向：同じ列で一番近いマスク画素までの距離
    for (let x = 0; x < w; x++) {
      let last = -1;
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        if (mask[i] > 0.5) last = y;
        outDist[i] = last < 0 || y - last > maxR ? FAR : y - last;
      }
      last = -1;
      for (let y = h - 1; y >= 0; y--) {
        const i = y * w + x;
        if (mask[i] > 0.5) last = y;
        if (last >= 0 && last - y <= maxR) {
          const dd = last - y;
          if (dd < outDist[i]) outDist[i] = dd;
        }
      }
    }
    // 横方向：近くの列の縦距離と組み合わせて最短距離を求める
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let any = false;
      for (let x = 0; x < w; x++) { const v = outDist[row + x]; g[x] = v; if (v < FAR) any = true; }
      if (!any) continue;                       // この行の近くに文字がない（すべて「とても遠い」のまま）
      let prevFinite = -1e9;                    // x より左（x を含む）で一番近い「遠くない」列
      let nextFinite = -1;                      // x より右（x を含む）で一番近い「遠くない」列
      for (let x = 0; x < w; x++) {
        if (g[x] < FAR) prevFinite = x;
        if (nextFinite < x) {
          nextFinite = x;
          while (nextFinite < w && g[nextFinite] >= FAR) nextFinite++;
        }
        if (x - prevFinite > maxR && nextFinite - x > maxR) { outDist[row + x] = FAR; continue; }
        let best = g[x] < FAR ? g[x] * g[x] : FAR;
        if (best === 0) { outDist[row + x] = 0; continue; }
        const lo = Math.max(0, x - maxR), hi = Math.min(w - 1, x + maxR);
        for (let xx = lo; xx <= hi; xx++) {
          const gv = g[xx];
          if (gv >= FAR) continue;
          const dx = xx - x;
          const d2 = dx * dx + gv * gv;
          if (d2 < best) best = d2;
        }
        outDist[row + x] = best >= FAR ? FAR : Math.sqrt(best);
      }
    }
  }

  const clamp255 = v => v < 0 ? 0 : (v > 255 ? 255 : v);

  class Compositor {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      const n = this.n = width * height;
      /** 背景色の推定を何コマ使い回すか（0 = 毎コマ推定。書き出しはこれ） */
      this.backgroundReuseFrames = 0;
      this.framesSinceEstimate = 0;
      this.hasEstimate = false;

      this.sw = Math.min(240, width);
      this.sh = Math.max(1, Math.round(height * this.sw / width));

      this.bgk = new Float32Array(n * 3);   // 推定した歌詞動画の背景色（R,G,B）
      this.fg = new Float32Array(n * 3);    // 背景色を取り除いた前景色（R,G,B）
      this.alpha = new Float32Array(n);
      this.work = new Float32Array(n);
      this.maskF = new Float32Array(n);
      this.lumM = new Float32Array(n);
      this.dist = new Float32Array(n);
      this.rowTmp = new Float32Array(Math.max(width, height));
      this.hw = Math.max(1, width >> 1);
      this.hh = Math.max(1, height >> 1);
      const hn = this.hw * this.hh;
      this.hLum = new Float32Array(hn);
      this.hMask = new Float32Array(hn);
      this.hTmp = new Float32Array(hn);

      const sn = this.sw * this.sh;
      this.sm = new Float32Array(sn * 3);
      this.smEst = new Float32Array(sn * 3);
      this.smNum = new Float32Array(sn * 3);
      this.smDen = new Float32Array(sn);
      this.smMask = new Float32Array(sn);
      this.smTmp = new Float32Array(sn);
      this.hist = new Int32Array(4096);

      this.ccLabel = null; this.ccParent = null; this.ccSize = null;
    }

    /** frame: 歌詞動画の 1 コマ、background: 背景の 1 コマ（同じサイズ）、output: 結果（すべて RGBA） */
    process(frame, background, output, s) {
      const W = this.width, H = this.height, n = this.n;
      if (frame.length < n * 4 || background.length < n * 4 || output.length < n * 4)
        throw new Error('フレームのサイズが合いません。');

      this.estimateBackground(frame);
      const bgk = this.bgk, fg = this.fg, alpha = this.alpha, work = this.work;
      const maskF = this.maskF, lumM = this.lumM, dist = this.dist;

      const d0 = s.KeyThreshold;
      const soft = Math.max(1, s.KeySoftness);

      // 1) 背景色との差から不透明度を求める
      for (let i = 0, j = 0, p = 0; i < n; i++, j += 3, p += 4) {
        const dr = frame[p] - bgk[j];
        const dg = frame[p + 1] - bgk[j + 1];
        const db = frame[p + 2] - bgk[j + 2];
        const a = (Math.sqrt(db * db + dg * dg + dr * dr) - d0) / soft;
        work[i] = a < 0 ? 0 : (a > 1 ? 1 : a);
      }

      // 2) 小さな点（背景の模様の残り）を消す：2x2 のオープニング
      erode2x2(work, alpha, W, H);
      dilate2x2(alpha, work, W, H);
      alpha.set(work);

      // 2b) 粒ノイズ：小さなかたまりを消す
      if (s.NoiseSize >= 0.5) this.removeSpeckles(s.NoiseSize);

      // 3) 前景色を取り出し、文字マスクと輝度を作る
      for (let i = 0, j = 0, p = 0; i < n; i++, j += 3, p += 4) {
        const a = alpha[i];
        if (a === 0) { maskF[i] = 0; lumM[i] = 0; continue; }   // 完全に透明（背景）：前景色は使わないので計算しない
        let fr, fgc, fb;
        if (a > 0.85) {
          fr = frame[p]; fgc = frame[p + 1]; fb = frame[p + 2];
        } else {
          const am = a < 0.05 ? 0.05 : a;
          fr = clamp255(bgk[j] + (frame[p] - bgk[j]) / am);
          fgc = clamp255(bgk[j + 1] + (frame[p + 1] - bgk[j + 1]) / am);
          fb = clamp255(bgk[j + 2] + (frame[p + 2] - bgk[j + 2]) / am);
        }
        fg[j] = fr; fg[j + 1] = fgc; fg[j + 2] = fb;
        const m = a > 0.4 ? 1 : 0;
        maskF[i] = m;
        lumM[i] = m * (0.114 * fb + 0.587 * fgc + 0.299 * fr) / 255;
      }

      const radius = Math.max(0, s.OutlineRadius);
      const useOutline = radius > 0.01;
      const auto = s.OutlineMode === OutlineColorMode.Auto;
      const hw = this.hw, hh = this.hh, hLum = this.hLum, hMask = this.hMask;

      if (useOutline) {
        distanceTransform(maskF, dist, this.rowTmp, W, H, Math.ceil(radius) + 2);
        if (auto) {
          // 周りの文字の明るさ（半分のサイズで計算して速くする）
          for (let y = 0; y < hh; y++) {
            const r0 = Math.min(2 * y, H - 1) * W, r1 = Math.min(2 * y + 1, H - 1) * W;
            for (let x = 0; x < hw; x++) {
              const x0 = Math.min(2 * x, W - 1), x1 = Math.min(2 * x + 1, W - 1);
              hLum[y * hw + x] = (lumM[r0 + x0] + lumM[r0 + x1] + lumM[r1 + x0] + lumM[r1 + x1]) * 0.25;
              hMask[y * hw + x] = (maskF[r0 + x0] + maskF[r0 + x1] + maskF[r1 + x0] + maskF[r1 + x1]) * 0.25;
            }
          }
          blurPlane(hLum, hLum, this.hTmp, hw, hh, Kernel2);
          blurPlane(hMask, hMask, this.hTmp, hw, hh, Kernel2);
        }
      }

      // 固定色の縁取り（R,G,B）
      let fixR, fixG, fixB;
      switch (s.OutlineMode) {
        case OutlineColorMode.Black: fixR = 0; fixG = 0; fixB = 0; break;
        case OutlineColorMode.Plum: fixR = 38; fixG = 18; fixB = 40; break;
        case OutlineColorMode.Custom: fixR = s.CustomR; fixG = s.CustomG; fixB = s.CustomB; break;
        default: fixR = 255; fixG = 255; fixB = 255; break;
      }

      // 4) 背景 → 縁取り → 前景の順に重ねる
      for (let y = 0; y < H; y++) {
        const row = y * W;
        const hrow = Math.min(y >> 1, hh - 1) * hw;
        for (let x = 0; x < W; x++) {
          const i = row + x, p = i * 4;
          const a = alpha[i];
          if (a === 0 && (!useOutline || dist[i] >= radius + 0.5)) {
            // 文字からも縁取りからも外れている：背景をそのまま使う
            output[p] = background[p]; output[p + 1] = background[p + 1]; output[p + 2] = background[p + 2]; output[p + 3] = 255;
            continue;
          }
          const j = i * 3;
          let or = background[p], og = background[p + 1], ob = background[p + 2];

          if (useOutline) {
            let oa = radius + 0.5 - dist[i];
            oa = oa < 0 ? 0 : (oa > 1 ? 1 : oa);
            if (a > oa) oa = a;
            if (oa > 0) {
              let cr = fixR, cg = fixG, cb = fixB;
              if (auto) {
                const hi = hrow + Math.min(x >> 1, hw - 1);
                const ln = hLum[hi] / Math.max(hMask[hi], 1e-4);
                let t = (ln - 0.45) / 0.2;   // 1 = 明るい文字 → 濃い縁取り
                t = t < 0 ? 0 : (t > 1 ? 1 : t);
                cb = 255 * (1 - t) + 40 * t;
                cg = 255 * (1 - t) + 18 * t;
                cr = 255 * (1 - t) + 38 * t;
              }
              or = or * (1 - oa) + cr * oa;
              og = og * (1 - oa) + cg * oa;
              ob = ob * (1 - oa) + cb * oa;
            }
          }

          or = or * (1 - a) + fg[j] * a;
          og = og * (1 - a) + fg[j + 1] * a;
          ob = ob * (1 - a) + fg[j + 2] * a;

          output[p] = or;             // output は Uint8ClampedArray（0～255 に収めて丸める）
          output[p + 1] = og;
          output[p + 2] = ob;
          output[p + 3] = 255;
        }
      }
    }

    // 歌詞動画の背景色の推定（縮小画像で一番多い色を基準に、ゆるやかな色の変化も追う）
    estimateBackground(frame) {
      const W = this.width, H = this.height, sw = this.sw, sh = this.sh, sn = sw * sh;
      const sm = this.sm, smEst = this.smEst, smMask = this.smMask, smNum = this.smNum, smDen = this.smDen, smTmp = this.smTmp;

      // 面積平均で縮小
      for (let sy = 0; sy < sh; sy++) {
        const y0 = Math.floor(sy * H / sh), y1 = Math.max(y0 + 1, Math.floor((sy + 1) * H / sh));
        for (let sx = 0; sx < sw; sx++) {
          const x0 = Math.floor(sx * W / sw), x1 = Math.max(x0 + 1, Math.floor((sx + 1) * W / sw));
          let r = 0, g = 0, b = 0;
          for (let y = y0; y < y1; y++) {
            let p = (y * W + x0) * 4;
            for (let x = x0; x < x1; x++, p += 4) { r += frame[p]; g += frame[p + 1]; b += frame[p + 2]; }
          }
          const cnt = (y1 - y0) * (x1 - x0);
          const k = (sy * sw + sx) * 3;
          sm[k] = r / cnt; sm[k + 1] = g / cnt; sm[k + 2] = b / cnt;
        }
      }

      // 前回推定したときと場面がほとんど同じなら、前回の推定をそのまま使う
      if (this.backgroundReuseFrames > 0 && this.hasEstimate && this.framesSinceEstimate < this.backgroundReuseFrames) {
        let err = 0, cnt = 0;
        for (let i = 0; i < sn; i++) {
          if (smMask[i] < 0.5) continue;
          const k = i * 3;
          err += Math.abs(sm[k] - smEst[k]) + Math.abs(sm[k + 1] - smEst[k + 1]) + Math.abs(sm[k + 2] - smEst[k + 2]);
          cnt++;
        }
        if (cnt > sn / 10 && err / (cnt * 3) < 2.5) {
          this.framesSinceEstimate++;
          return;
        }
      }
      this.framesSinceEstimate = 1;
      this.hasEstimate = true;

      // 一番多い色（16 段階に量子化。並びは Windows 版と同じ B,G,R）
      const hist = this.hist;
      hist.fill(0);
      const keyOf = k => (((sm[k + 2] / 16) | 0) << 8) | (((sm[k + 1] / 16) | 0) << 4) | ((sm[k] / 16) | 0);
      for (let i = 0; i < sn; i++) hist[keyOf(i * 3)]++;
      let mode = 0;
      for (let i = 1; i < 4096; i++) if (hist[i] > hist[mode]) mode = i;

      let mr = 0, mg = 0, mb = 0, mc = 0;
      for (let i = 0; i < sn; i++) {
        const k = i * 3;
        if (keyOf(k) === mode) { mr += sm[k]; mg += sm[k + 1]; mb += sm[k + 2]; mc++; }
      }
      const cR = mr / mc, cG = mg / mc, cB = mb / mc;

      for (let i = 0; i < sn; i++) {
        const k = i * 3;
        const dr = sm[k] - cR, dg = sm[k + 1] - cG, db = sm[k + 2] - cB;
        smMask[i] = (db * db + dg * dg + dr * dr) < 45 * 45 ? 1 : 0;
      }

      for (let iter = 0; iter < 3; iter++) {
        // マスクした部分だけで色をなめらかに広げる（正規化畳み込み）
        for (let c = 0; c < 3; c++) {
          for (let i = 0; i < sn; i++) smTmp[i] = sm[i * 3 + c] * smMask[i];
          blurPlane(smTmp, smTmp, smDen, sw, sh, Kernel12);
          for (let i = 0; i < sn; i++) smNum[i * 3 + c] = smTmp[i];
        }
        blurPlane(smMask, smDen, smTmp, sw, sh, Kernel12);

        for (let i = 0; i < sn; i++) {
          const k = i * 3;
          const den = smDen[i];
          if (den > 0.02) {
            const inv = 1 / Math.max(den, 1e-4);
            smEst[k] = smNum[k] * inv; smEst[k + 1] = smNum[k + 1] * inv; smEst[k + 2] = smNum[k + 2] * inv;
          } else {
            smEst[k] = cR; smEst[k + 1] = cG; smEst[k + 2] = cB;
          }
          const dr = sm[k] - smEst[k], dg = sm[k + 1] - smEst[k + 1], db = sm[k + 2] - smEst[k + 2];
          smMask[i] = (db * db + dg * dg + dr * dr) < 14 * 14 ? 1 : 0;
        }
      }

      // フル解像度へ拡大（双線形）
      const bgk = this.bgk;
      const scaleX = sw / W, scaleY = sh / H;
      const xs0 = new Int32Array(W), xs1 = new Int32Array(W), wxs = new Float32Array(W);
      for (let x = 0; x < W; x++) {
        let fx = (x + 0.5) * scaleX - 0.5; if (fx < 0) fx = 0;
        let x0 = fx | 0; if (x0 > sw - 1) x0 = sw - 1;
        xs0[x] = x0; xs1[x] = Math.min(x0 + 1, sw - 1);
        let wx = fx - x0; if (wx > 1) wx = 1; wxs[x] = wx;
      }
      for (let y = 0; y < H; y++) {
        let fy = (y + 0.5) * scaleY - 0.5; if (fy < 0) fy = 0;
        let y0 = fy | 0; if (y0 > sh - 1) y0 = sh - 1;
        const y1 = Math.min(y0 + 1, sh - 1);
        let wy = fy - y0; if (wy > 1) wy = 1;
        for (let x = 0; x < W; x++) {
          const wx = wxs[x];
          const k00 = (y0 * sw + xs0[x]) * 3, k01 = (y0 * sw + xs1[x]) * 3, k10 = (y1 * sw + xs0[x]) * 3, k11 = (y1 * sw + xs1[x]) * 3;
          const j = (y * W + x) * 3;
          for (let c = 0; c < 3; c++) {
            const top = smEst[k00 + c] * (1 - wx) + smEst[k01 + c] * wx;
            const bot = smEst[k10 + c] * (1 - wx) + smEst[k11 + c] * wx;
            bgk[j + c] = top * (1 - wy) + bot * wy;
          }
        }
      }
    }

    /**
     * 残った部分をつながり（かたまり）ごとに分け、面積が size×size より小さいものを消す。
     * あわせて、残したかたまりの近く以外にある薄い粒（半透明のざらつき）も消す。
     */
    removeSpeckles(size) {
      const W = this.width, H = this.height, n = this.n;
      const alpha = this.alpha, maskF = this.maskF;
      const on = 0.4;
      const minArea = Math.max(1, Math.round(size * size));
      if (!this.ccLabel) this.ccLabel = new Int32Array(n);
      if (!this.ccParent) this.ccParent = new Int32Array((n >> 1) + 2);
      const label = this.ccLabel;
      let parent = this.ccParent;

      const find = a => {
        while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
        return a;
      };
      const union = (a, b) => {
        a = find(a); b = find(b);
        if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; }
      };

      // 1 回目：仮の番号を付けながら、つながっているもの同士をまとめる（8 方向）
      let next = 1;
      for (let y = 0; y < H; y++) {
        const row = y * W, up = row - W;
        for (let x = 0; x < W; x++) {
          const i = row + x;
          if (alpha[i] <= on) { label[i] = 0; continue; }
          let l = 0;
          if (x > 0 && label[i - 1] !== 0) l = label[i - 1];
          if (y > 0) {
            let v;
            if (x > 0 && (v = label[up + x - 1]) !== 0) { if (l === 0) l = v; else union(l, v); }
            if ((v = label[up + x]) !== 0) { if (l === 0) l = v; else union(l, v); }
            if (x < W - 1 && (v = label[up + x + 1]) !== 0) { if (l === 0) l = v; else union(l, v); }
          }
          if (l === 0) {
            if (next >= parent.length) {
              const np = new Int32Array(parent.length * 2); np.set(parent);
              parent = this.ccParent = np;
            }
            l = next++;
            parent[l] = l;
          }
          label[i] = l;
        }
      }

      // かたまりごとの面積
      if (!this.ccSize || this.ccSize.length < next) this.ccSize = new Int32Array(Math.max(next, 1024) * 2);
      const area = this.ccSize;
      area.fill(0, 0, next);
      for (let l = 1; l < next; l++) parent[l] = find(l);
      for (let i = 0; i < n; i++) { const l = label[i]; if (l !== 0) area[parent[l]]++; }

      // 2 回目：小さいかたまりを消し、残すかたまりのマスクを作る
      for (let i = 0; i < n; i++) {
        const l = label[i];
        if (l === 0) { maskF[i] = 0; continue; }
        if (area[parent[l]] < minArea) { alpha[i] = 0; maskF[i] = 0; }
        else maskF[i] = 1;
      }

      // 残したかたまりから 2 画素以上離れた薄い部分（半透明のざらつき）も消す
      distanceTransform(maskF, this.dist, this.rowTmp, W, H, 3);
      const dist = this.dist;
      for (let i = 0; i < n; i++) {
        if (alpha[i] > 0 && alpha[i] <= on && dist[i] > 2) alpha[i] = 0;
      }
    }
  }

  return { Compositor, OutlineColorMode, defaultSettings };
}

if (typeof self !== 'undefined') self.CompositorLib = createCompositorLib();
if (typeof module !== 'undefined') module.exports = { createCompositorLib };
