// 再生中のプレビューを GPU（WebGL2）で合成する。
// 計算の流れは compositor.js（Windows 版 Compositor.cs）と同じだが、
//  ・粒ノイズを消す：つながったかたまりの面積の代わりに「周りの四角の中の文字の画素数」で判断する（近い結果）
//  ・中間の値は 8 ビットで持つ
// ため、止めたときの表示（CPU の正確な計算）とごくわずかに違うことがある。書き出しには使わない。
(function () {
  'use strict';

  const VS = `#version 300 es
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const HEAD = `#version 300 es
  precision highp float;
  precision highp int;
  out vec4 o;
  uniform ivec2 uSize;               // 計算する大きさ（w×h）
  ivec2 P() { return ivec2(gl_FragCoord.xy); }   // 画像の座標（行 0 が画像の上）
  ivec2 C(ivec2 q) { return clamp(q, ivec2(0), uSize - 1); }
  `;

  // 動画のコマ・背景を計算する大きさにする（rect = 元の画像のどこを使うか。cover の切り取り用）
  const FS_RESAMPLE = HEAD + `
  uniform sampler2D uSrc; uniform vec4 uRect;
  void main() {
    vec2 uv = uRect.xy + (gl_FragCoord.xy / vec2(uSize)) * uRect.zw;
    o = vec4(texture(uSrc, uv).rgb, 1.0);
  }`;

  // 1) 背景色との差から不透明度
  const FS_ALPHA = HEAD + `
  uniform sampler2D uFg; uniform sampler2D uEst; uniform float uD0; uniform float uSoft;
  void main() {
    ivec2 p = P();
    vec3 f = texelFetch(uFg, p, 0).rgb * 255.0;
    vec3 b = texture(uEst, (vec2(p) + 0.5) / vec2(uSize)).rgb * 255.0;
    float a = (length(f - b) - uD0) / uSoft;
    o = vec4(clamp(a, 0.0, 1.0), 0.0, 0.0, 1.0);
  }`;

  // 2) 2x2 のオープニング（小さな点を消す）
  const FS_ERODE = HEAD + `
  uniform sampler2D uA;
  void main() {
    ivec2 p = P();
    float m = texelFetch(uA, p, 0).r;
    m = min(m, texelFetch(uA, C(p + ivec2(-1, 0)), 0).r);
    m = min(m, texelFetch(uA, C(p + ivec2(0, -1)), 0).r);
    m = min(m, texelFetch(uA, C(p + ivec2(-1, -1)), 0).r);
    o = vec4(m, 0.0, 0.0, 1.0);
  }`;
  const FS_DILATE = HEAD + `
  uniform sampler2D uA;
  void main() {
    ivec2 p = P();
    float m = texelFetch(uA, p, 0).r;
    m = max(m, texelFetch(uA, C(p + ivec2(1, 0)), 0).r);
    m = max(m, texelFetch(uA, C(p + ivec2(0, 1)), 0).r);
    m = max(m, texelFetch(uA, C(p + ivec2(1, 1)), 0).r);
    o = vec4(m, 0.0, 0.0, 1.0);
  }`;

  // 2b) 粒ノイズ：周りの (2R+1)×(2R+1) の中の文字の画素数を数える（横 → 縦）
  const FS_HSUM = HEAD + `
  uniform sampler2D uA; uniform int uR;
  void main() {
    ivec2 p = P(); float s = 0.0;
    for (int d = -30; d <= 30; d++) {
      if (d < -uR || d > uR) continue;
      int x = p.x + d;
      if (x < 0 || x >= uSize.x) continue;
      s += texelFetch(uA, ivec2(x, p.y), 0).r > 0.4 ? 1.0 : 0.0;
    }
    o = vec4(s / 255.0, 0.0, 0.0, 1.0);
  }`;
  const FS_KEEP = HEAD + `
  uniform sampler2D uA; uniform sampler2D uH; uniform int uR; uniform float uMinArea;
  void main() {
    ivec2 p = P(); float s = 0.0;
    for (int d = -30; d <= 30; d++) {
      if (d < -uR || d > uR) continue;
      int y = p.y + d;
      if (y < 0 || y >= uSize.y) continue;
      s += floor(texelFetch(uH, ivec2(p.x, y), 0).r * 255.0 + 0.5);
    }
    bool m = texelFetch(uA, p, 0).r > 0.4;
    o = vec4((m && s >= uMinArea) ? 1.0 : 0.0, 0.0, 0.0, 1.0);
  }`;
  // 残したかたまりから 2 画素以上離れた薄い粒も消す
  const FS_APPLY = HEAD + `
  uniform sampler2D uA; uniform sampler2D uK;
  void main() {
    ivec2 p = P();
    float a = texelFetch(uA, p, 0).r;
    float k = texelFetch(uK, p, 0).r;
    if (a > 0.4 && k < 0.5) a = 0.0;
    if (a > 0.0 && a <= 0.4) {
      bool near = false;
      for (int dy = -2; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy > 4) continue;
        ivec2 q = p + ivec2(dx, dy);
        if (q.x < 0 || q.y < 0 || q.x >= uSize.x || q.y >= uSize.y) continue;
        if (texelFetch(uK, q, 0).r > 0.5) near = true;
      }
      if (!near) a = 0.0;
    }
    o = vec4(a, 0.0, 0.0, 1.0);
  }`;

  // 3) 文字マスクと輝度（前景色を取り出して計算）
  const FS_MASKLUM = HEAD + `
  uniform sampler2D uA; uniform sampler2D uFg; uniform sampler2D uEst;
  void main() {
    ivec2 p = P();
    float a = texelFetch(uA, p, 0).r;
    if (a <= 0.4) { o = vec4(0.0); return; }
    vec3 f = texelFetch(uFg, p, 0).rgb * 255.0;
    vec3 c = f;
    if (a <= 0.85) {
      vec3 b = texture(uEst, (vec2(p) + 0.5) / vec2(uSize)).rgb * 255.0;
      c = clamp(b + (f - b) / max(a, 0.05), 0.0, 255.0);
    }
    float lum = (0.114 * c.b + 0.587 * c.g + 0.299 * c.r) / 255.0;
    o = vec4(1.0, lum, 0.0, 1.0);
  }`;

  // 文字までの距離（縦 → 横の 2 段階）
  const FS_EDTV = HEAD + `
  uniform sampler2D uM; uniform int uMaxR;
  void main() {
    ivec2 p = P(); float best = 255.0;
    for (int k = 0; k <= 14; k++) {
      if (k > uMaxR) break;
      int y0 = p.y - k, y1 = p.y + k;
      if ((y0 >= 0 && texelFetch(uM, ivec2(p.x, y0), 0).r > 0.5) ||
          (y1 < uSize.y && texelFetch(uM, ivec2(p.x, y1), 0).r > 0.5)) { best = float(k); break; }
    }
    o = vec4(best / 255.0, 0.0, 0.0, 1.0);
  }`;
  const FS_EDTH = HEAD + `
  uniform sampler2D uV; uniform int uMaxR;
  void main() {
    ivec2 p = P(); float best = 1e9;
    for (int d = -14; d <= 14; d++) {
      if (d < -uMaxR || d > uMaxR) continue;
      int x = p.x + d;
      if (x < 0 || x >= uSize.x) continue;
      float g = floor(texelFetch(uV, ivec2(x, p.y), 0).r * 255.0 + 0.5);
      if (g >= 255.0) continue;
      best = min(best, float(d * d) + g * g);
    }
    float dist = best >= 1e9 ? 16.0 : sqrt(best);
    o = vec4(min(dist, 16.0) / 16.0, 0.0, 0.0, 1.0);
  }`;

  // 縁取りの色（自動）：周りの文字の明るさを、半分の大きさでぼかして求める
  const FS_HALF = HEAD + `
  uniform sampler2D uML; uniform ivec2 uFull;
  void main() {
    ivec2 p = P() * 2; vec2 s = vec2(0.0);
    for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) {
      vec4 v = texelFetch(uML, clamp(p + ivec2(dx, dy), ivec2(0), uFull - 1), 0);
      s += vec2(v.g, v.r);       // (輝度×マスク, マスク)
    }
    o = vec4(s * 0.25, 0.0, 1.0);
  }`;
  const FS_BLUR = HEAD + `
  uniform sampler2D uS; uniform ivec2 uDir; uniform float uK[9];
  int refl(int i, int n) { if (n == 1) return 0; for (int t = 0; t < 4; t++) { if (i < 0) i = -i; if (i >= n) i = 2 * n - 2 - i; } return clamp(i, 0, n - 1); }
  void main() {
    ivec2 p = P(); vec2 acc = texelFetch(uS, p, 0).rg * uK[0];
    for (int k = 1; k <= 8; k++) {
      ivec2 a = p - uDir * k, b = p + uDir * k;
      a = ivec2(refl(a.x, uSize.x), refl(a.y, uSize.y));
      b = ivec2(refl(b.x, uSize.x), refl(b.y, uSize.y));
      acc += (texelFetch(uS, a, 0).rg + texelFetch(uS, b, 0).rg) * uK[k];
    }
    o = vec4(acc, 0.0, 1.0);
  }`;

  // 4) 背景 → 縁取り → 前景の順に重ねて、画面に描く
  const FS_FINAL = HEAD + `
  uniform sampler2D uFg; uniform sampler2D uBg; uniform sampler2D uEst; uniform sampler2D uA;
  uniform sampler2D uD; uniform sampler2D uL; uniform ivec2 uHalf;
  uniform float uRadius; uniform int uMode; uniform vec3 uFix; uniform int uView;
  void main() {
    ivec2 p = ivec2(int(gl_FragCoord.x), uSize.y - 1 - int(gl_FragCoord.y));   // 画面は下が 0 なので上下を戻す
    vec3 bg = texelFetch(uBg, p, 0).rgb * 255.0;
    vec3 f = texelFetch(uFg, p, 0).rgb * 255.0;
    if (uView == 1) { o = vec4(f / 255.0, 1.0); return; }
    if (uView == 2) { o = vec4(bg / 255.0, 1.0); return; }
    float a = texelFetch(uA, p, 0).r;
    vec3 col = bg;
    if (uRadius > 0.01) {
      float dist = texelFetch(uD, p, 0).r * 16.0;
      float oa = clamp(uRadius + 0.5 - dist, 0.0, 1.0);
      oa = max(oa, a);
      if (oa > 0.0) {
        vec3 c = uFix;
        if (uMode == 0) {
          ivec2 h = min(p / 2, uHalf - 1);
          vec2 v = texelFetch(uL, h, 0).rg;
          float ln = v.x / max(v.y, 1e-4);
          float t = clamp((ln - 0.45) / 0.2, 0.0, 1.0);
          c = vec3(255.0 * (1.0 - t) + 38.0 * t, 255.0 * (1.0 - t) + 18.0 * t, 255.0 * (1.0 - t) + 40.0 * t);
        }
        col = col * (1.0 - oa) + c * oa;
      }
    }
    if (a > 0.0) {
      vec3 fc = f;
      if (a <= 0.85) {
        vec3 b = texture(uEst, (vec2(p) + 0.5) / vec2(uSize)).rgb * 255.0;
        fc = clamp(b + (f - b) / max(a, 0.05), 0.0, 255.0);
      }
      col = col * (1.0 - a) + fc * a;
    }
    o = vec4(col / 255.0, 1.0);
  }`;

  function gaussian(sigma) {
    const size = (Math.round(sigma * 8 + 1)) | 1, c = size >> 1, k = [];
    let sum = 0;
    for (let i = 0; i < size; i++) { const v = Math.exp(-(i - c) * (i - c) / (2 * sigma * sigma)); k.push(v); sum += v; }
    return k.map(v => v / sum).slice(c);   // 中心から片側（9 個）
  }
  const K2 = gaussian(2.0);

  class GpuCompositor {
    /** canvas に WebGL2 で描く。使えないときは例外 */
    constructor(canvas) {
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL2 が使えません');
      this.gl = gl;
      this.canvas = canvas;
      this.progs = {};
      for (const [name, fs] of Object.entries({ resample: FS_RESAMPLE, alpha: FS_ALPHA, erode: FS_ERODE, dilate: FS_DILATE, hsum: FS_HSUM, keep: FS_KEEP, apply: FS_APPLY, masklum: FS_MASKLUM, edtv: FS_EDTV, edth: FS_EDTH, half: FS_HALF, blur: FS_BLUR, final: FS_FINAL }))
        this.progs[name] = this.program(fs);
      this.vao = gl.createVertexArray();
      this.w = this.h = 0;
      this.srcFg = this.newTex(true);
      this.srcBg = this.newTex(true);
      this.est = this.newTex(false, true);
      this.bgImageKey = null;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }

    program(fs) {
      const gl = this.gl;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const loc = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        const name = info.name.replace(/\[0\]$/, '');
        loc[name] = gl.getUniformLocation(p, info.name);
      }
      return { p, loc };
    }

    newTex(mip, linear) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : (linear ? gl.LINEAR : gl.NEAREST));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, (mip || linear) ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    target(w, h) {
      const gl = this.gl;
      const tex = this.newTex(false, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb, w, h };
    }

    resize(w, h) {
      if (w === this.w && h === this.h) return;
      const gl = this.gl;
      if (this.t) for (const t of Object.values(this.t)) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
      this.w = w; this.h = h;
      this.hw = Math.max(1, w >> 1); this.hh = Math.max(1, h >> 1);
      this.t = {
        fg: this.target(w, h), bg: this.target(w, h),
        a0: this.target(w, h), a1: this.target(w, h), a2: this.target(w, h),
        hs: this.target(w, h), keep: this.target(w, h), a3: this.target(w, h),
        ml: this.target(w, h), ev: this.target(w, h), dist: this.target(w, h),
        h0: this.target(this.hw, this.hh), h1: this.target(this.hw, this.hh), h2: this.target(this.hw, this.hh),
      };
      this.canvas.width = w; this.canvas.height = h;
      this.bgImageKey = null;
    }

    /** 1 回の描画（out = 書き込み先。null なら画面） */
    pass(name, out, uniforms, textures) {
      const gl = this.gl, pr = this.progs[name];
      gl.useProgram(pr.p);
      if (out) { gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb); gl.viewport(0, 0, out.w, out.h); }
      else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.w, this.h); }
      const size = out ? [out.w, out.h] : [this.w, this.h];
      if (pr.loc.uSize) gl.uniform2i(pr.loc.uSize, size[0], size[1]);
      let unit = 0;
      for (const [k, tex] of Object.entries(textures || {})) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (pr.loc[k]) gl.uniform1i(pr.loc[k], unit);
        unit++;
      }
      for (const [k, v] of Object.entries(uniforms || {})) {
        const l = pr.loc[k];
        if (!l) continue;
        if (Array.isArray(v)) {
          if (k === 'uK') gl.uniform1fv(l, v);
          else if (v.length === 2 && Number.isInteger(v[0]) && k !== 'uRect') gl.uniform2i(l, v[0], v[1]);
          else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]);
          else if (v.length === 4) gl.uniform4f(l, v[0], v[1], v[2], v[3]);
        } else if (k === 'uR' || k === 'uMaxR' || k === 'uMode' || k === 'uView') gl.uniform1i(l, v);
        else gl.uniform1f(l, v);
      }
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    upload(tex, source, mip) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    }

    /** 背景色の推定（sw×sh の RGBA）を入れる */
    setEstimate(rgba, sw, sh) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.est);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    }

    static coverRect(sw, sh, w, h) {
      const k = Math.max(w / sw, h / sh), cw = w / k, ch = h / k;
      return [(sw - cw) / 2 / sw, (sh - ch) / 2 / sh, cw / sw, ch / sh];
    }

    /**
     * 1 コマ合成して画面に描く。
     * fg：歌詞動画のコマ（VideoFrame）、bg：背景（VideoFrame か ImageBitmap、bgKey が同じなら前のを使う）
     * view：0 合成結果 / 1 元の歌詞動画 / 2 背景
     */
    render(fg, bg, bgKey, s, view) {
      const gl = this.gl, T = this.t, w = this.w, h = this.h;
      // 元の画像を計算する大きさにする（ミップマップで縮小してきれいに）
      this.upload(this.srcFg, fg, true);
      this.pass('resample', T.fg, { uRect: [0, 0, 1, 1] }, { uSrc: this.srcFg });
      if (bg) {
        if (!(bgKey && bgKey === this.bgImageKey)) {
          this.upload(this.srcBg, bg, true);
          const bw = bg.displayWidth || bg.width, bh = bg.displayHeight || bg.height;
          this.pass('resample', T.bg, { uRect: GpuCompositor.coverRect(bw, bh, w, h) }, { uSrc: this.srcBg });
          this.bgImageKey = bgKey || null;
        }
      } else if (this.bgImageKey !== '__black') {
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.bg.fb); gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        this.bgImageKey = '__black';
      }
      if (view !== 0) {
        this.pass('final', null, { uView: view, uRadius: 0, uMode: 1, uFix: [0, 0, 0], uHalf: [this.hw, this.hh] },
          { uFg: T.fg.tex, uBg: T.bg.tex, uEst: this.est, uA: T.a0.tex, uD: T.dist.tex, uL: T.h2.tex });
        return;
      }

      this.pass('alpha', T.a0, { uD0: s.KeyThreshold, uSoft: Math.max(1, s.KeySoftness) }, { uFg: T.fg.tex, uEst: this.est });
      this.pass('erode', T.a1, {}, { uA: T.a0.tex });
      this.pass('dilate', T.a2, {}, { uA: T.a1.tex });
      let A = T.a2;
      if (s.NoiseSize >= 0.5) {
        const R = Math.max(1, Math.min(30, Math.round(s.NoiseSize)));
        this.pass('hsum', T.hs, { uR: R }, { uA: A.tex });
        this.pass('keep', T.keep, { uR: R, uMinArea: Math.max(1, Math.round(s.NoiseSize * s.NoiseSize)) }, { uA: A.tex, uH: T.hs.tex });
        this.pass('apply', T.a3, {}, { uA: A.tex, uK: T.keep.tex });
        A = T.a3;
      }
      const radius = Math.max(0, s.OutlineRadius);
      const auto = s.OutlineMode === 0;
      if (radius > 0.01) {
        const maxR = Math.min(14, Math.ceil(radius) + 2);
        this.pass('masklum', T.ml, {}, { uA: A.tex, uFg: T.fg.tex, uEst: this.est });
        this.pass('edtv', T.ev, { uMaxR: maxR }, { uM: T.ml.tex });
        this.pass('edth', T.dist, { uMaxR: maxR }, { uV: T.ev.tex });
        if (auto) {
          this.pass('half', T.h0, { uFull: [w, h] }, { uML: T.ml.tex });
          this.pass('blur', T.h1, { uDir: [1, 0], uK: K2 }, { uS: T.h0.tex });
          this.pass('blur', T.h2, { uDir: [0, 1], uK: K2 }, { uS: T.h1.tex });
        }
      }
      let fix;
      switch (s.OutlineMode) {
        case 2: fix = [0, 0, 0]; break;
        case 3: fix = [38, 18, 40]; break;
        case 4: fix = [s.CustomR, s.CustomG, s.CustomB]; break;
        default: fix = [255, 255, 255];
      }
      this.pass('final', null, { uView: 0, uRadius: radius, uMode: auto ? 0 : 1, uFix: fix, uHalf: [this.hw, this.hh] },
        { uFg: T.fg.tex, uBg: T.bg.tex, uEst: this.est, uA: A.tex, uD: T.dist.tex, uL: T.h2.tex });
    }
  }

  self.GpuCompositor = GpuCompositor;
})();
