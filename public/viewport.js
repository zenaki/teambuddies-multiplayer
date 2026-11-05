"use strict";
// Per-player "focus" view: Team Buddies renders 2P as top/bottom halves and 3-4P as quadrants
// on one PS1 screen. The host detects which layout is on screen (it has the full-resolution
// frame) and tells every client; each client then crops the shared stream to its own viewport.

// Rects are [x0, y0, x1, y1] in fractions of the frame, measured from the game's own dividers.
const LAYOUTS = {
  full: {},
  h2:   { 1: [0, 0.017, 1, 0.511], 2: [0, 0.518, 1, 1] },
  quad: { 1: [0, 0.017, 0.496, 0.511], 2: [0.5, 0.017, 0.997, 0.511],
          3: [0, 0.518, 0.496, 1],     4: [0.5, 0.518, 0.997, 1] },
};
// 3 players: same quadrants, bottom-right is left empty -> P4 (spectator) keeps the full view
LAYOUTS.quad3 = { 1: LAYOUTS.quad[1], 2: LAYOUTS.quad[2], 3: LAYOUTS.quad[3] };
const RADAR_RECT = [0.40, 0.31, 0.60, 0.66]; // shared timer + radar drawn across the quad centre

// ---- Layout detection (runs on the host) ------------------------------------
// The dividers are 1-3 px dark lines with brighter game scenery on both sides. Menus and loading
// screens also contain black areas, so require "dark line, bright neighbour" along most of it.
const DET_W = 640, DET_H = 480;
function detectLayout(source, ctx) {
  ctx.drawImage(source, 0, 0, DET_W, DET_H);
  const px = ctx.getImageData(0, 0, DET_W, DET_H).data;
  const L = (x, y) => { const i = (y * DET_W + x) * 4; return (px[i] + px[i + 1] + px[i + 2]) / 3; };
  const line = (vertical, pos, from, to) => {
    let best = 0; const c = Math.round(pos * (vertical ? DET_W : DET_H));
    for (let k = c - 4; k <= c + 4; k++) {
      let ok = 0, n = 0;
      for (let t = Math.round(from * (vertical ? DET_H : DET_W)); t < to * (vertical ? DET_H : DET_W); t += 2) {
        n++;
        const l = vertical ? L(k, t) : L(t, k);
        const a = vertical ? L(k - 8, t) : L(t, k - 8), b = vertical ? L(k + 8, t) : L(t, k + 8);
        if (l < 70 && Math.max(a, b) > l + 40) ok++;
      }
      best = Math.max(best, ok / n);
    }
    return best;
  };
  const hLeft = line(false, 0.514, 0.02, 0.48);
  if (hLeft < 0.7) return "full";
  if (line(true, 0.497, 0.04, 0.48) > 0.7) {
    // 3P leaves the bottom-right quadrant black (skip the shared radar box near the centre)
    let dark = 0, n = 0;
    for (let y = Math.round(0.68 * DET_H); y < 0.97 * DET_H; y += 6)
      for (let x = Math.round(0.64 * DET_W); x < 0.97 * DET_W; x += 6) { n++; if (L(x, y) < 20) dark++; }
    return dark / n > 0.95 ? "quad3" : "quad";
  }
  if (line(false, 0.514, 0.52, 0.98) > 0.7) return "h2";
  return "full";
}

class LayoutDetector {
  constructor(video, onChange) {
    this.video = video; this.onChange = onChange; this.layout = "full";
    this.override = "auto"; this.pending = null;
    const c = document.createElement("canvas"); c.width = DET_W; c.height = DET_H;
    this.ctx = c.getContext("2d", { willReadFrequently: true });
    this.timer = setInterval(() => this.tick(), 400);
  }
  setOverride(v) { this.override = v; this.tick(true); }
  tick(force) {
    let next;
    if (this.override !== "auto") next = this.override;
    else {
      if (this.video.readyState < 2) return;
      const seen = detectLayout(this.video, this.ctx);
      // require two identical readings in a row so a single odd frame doesn't flip the view
      if (seen !== this.pending) { this.pending = seen; return; }
      next = seen;
    }
    if (next !== this.layout || force) { this.layout = next; this.onChange(next); }
  }
}

// ---- Renderer -----------------------------------------------------------------
class FocusView {
  constructor(video, canvas) {
    this.video = video; this.canvas = canvas; this.ctx = canvas.getContext("2d");
    this.layout = "full"; this.slot = 1; this.focus = true; this.radar = true;
    const loop = () => {
      this.draw();
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop); else requestAnimationFrame(loop);
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop); else requestAnimationFrame(loop);
    addEventListener("resize", () => this.draw());
  }
  // display aspect ratio (width / height) of what is currently shown
  aspect() { const [x0, y0, x1, y1] = this.rect(); return ((x1 - x0) * 4) / ((y1 - y0) * 3); }
  rect() { return (this.focus && LAYOUTS[this.layout] && LAYOUTS[this.layout][this.slot]) || [0, 0, 1, 1]; }
  draw() {
    const v = this.video, c = this.canvas, ctx = this.ctx;
    const dpr = devicePixelRatio || 1, cw = Math.round(c.clientWidth * dpr), ch = Math.round(c.clientHeight * dpr);
    if (!cw || !ch) return;
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cw, ch);
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    // The PS1 frame is shown at 4:3 regardless of its pixel resolution.
    const dispW = vh * 4 / 3;
    const [x0, y0, x1, y1] = this.rect();
    const sw = (x1 - x0) * vw, sh = (y1 - y0) * vh, aspect = ((x1 - x0) * dispW) / sh;
    let dw = cw, dh = cw / aspect;
    if (dh > ch) { dh = ch; dw = ch * aspect; }
    const dx = (cw - dw) / 2, dy = (ch - dh) / 2;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(v, x0 * vw, y0 * vh, sw, sh, dx, dy, dw, dh);
    if (this.focus && this.radar && this.layout.startsWith("quad") && this.rect()[2] - this.rect()[0] < 1) {
      const [rx0, ry0, rx1, ry1] = RADAR_RECT;
      const rw = dw * 0.26, rh = rw * ((ry1 - ry0) * vh) / ((rx1 - rx0) * dispW);
      const ix = dx + dw - rw - dw * 0.02, iy = dy + dh - rh - dh * 0.03;
      ctx.globalAlpha = 0.92;
      ctx.drawImage(v, rx0 * vw, ry0 * vh, (rx1 - rx0) * vw, (ry1 - ry0) * vh, ix, iy, rw, rh);
      ctx.globalAlpha = 1; ctx.strokeStyle = "rgba(255,255,255,.5)"; ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeRect(ix, iy, rw, rh);
    }
  }
}
