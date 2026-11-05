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
    if (this.showTags !== false) this.drawTags({ rect: [x0, y0, x1, y1], dx, dy, dw, dh });
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

// ---- Name tags above the controlled buddies -------------------------------------
// Tags are [slot, fx, fy, viewport] in fractions of the video frame. The host computes them from
// the game's memory (gamemem.js): every player-controlled buddy is projected into every viewport,
// so you also see the names of other players walking through your screen. Buddies controlled by
// nobody connected (bots) get no tag.
const PLAYER_COLORS = { 1: "#4aa3ff", 2: "#ff5d5d", 3: "#3ccf7a", 4: "#f5b301" };
// Fallback when the game's memory can't be read: each camera follows its player's buddy,
// so the head is near a fixed point of that player's viewport.
const HEAD_POINT = { quad: [0.5, 0.31], quad3: [0.5, 0.31], h2: [0.5, 0.30] };
function fallbackTags(layout) {
  const rects = LAYOUTS[layout] || {}, hp = HEAD_POINT[layout], out = [];
  if (!hp) return out;
  for (const s in rects) {
    const [x0, y0, x1, y1] = rects[s];
    out.push([+s, x0 + hp[0] * (x1 - x0), y0 + hp[1] * (y1 - y0), +s - 1]);
  }
  return out;
}

FocusView.prototype.setNames = function (names) { this.names = names || {}; };
// Tag snapshots arrive ~30x/s, ahead of the video they belong to. They are replayed `tagDelay` ms
// after arrival and interpolated between snapshots so the labels stay glued to the characters.
FocusView.prototype.pushTags = function (tags, t = performance.now()) {
  const tl = this.tagLine || (this.tagLine = []);
  tl.push({ t, tags: tags || [] });
  while (tl.length > 2 && tl[0].t < t - 1500) tl.shift();
};
FocusView.prototype.currentTags = function () {
  const tl = this.tagLine;
  if (!tl || !tl.length) return [];
  const t = performance.now() - (this.tagDelay || 0);
  let i = tl.length - 1;
  while (i > 0 && tl[i].t > t) i--;
  const a = tl[i], b = tl[i + 1];
  if (a.t > t || !b || b.t - a.t > 250) return a.tags;
  const f = (t - a.t) / (b.t - a.t), key = x => x[0] * 8 + x[3];
  const next = new Map(b.tags.map(x => [key(x), x]));
  return a.tags.map(x => { const y = next.get(key(x)); return y ? [x[0], x[1] + (y[1] - x[1]) * f, x[2] + (y[2] - x[2]) * f, x[3]] : x; });
};
FocusView.prototype.drawTags = function (geo) {
  const names = this.names || {}, ctx = this.ctx, dpr = devicePixelRatio || 1;
  const [x0, y0, x1, y1] = geo.rect;
  const own = this.focus && LAYOUTS[this.layout] && LAYOUTS[this.layout][this.slot] ? this.slot - 1 : -1;
  for (const [slot, fx, fy, vp] of this.currentTags()) {
    const name = names[slot];
    if (!name) continue;                    // not a connected human -> bot, no tag
    if (own >= 0 && vp !== own) continue;   // focused: only tags of my own viewport
    if (fx < x0 || fx > x1 || fy < y0 - 0.02 || fy > y1) continue;
    const cx = geo.dx + (fx - x0) / (x1 - x0) * geo.dw, cy = geo.dy + (Math.max(fy, y0) - y0) / (y1 - y0) * geo.dh;
    const fs = Math.max(11 * dpr, Math.min(18 * dpr, geo.dh * 0.045));
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    const tw = ctx.measureText(name).width, padX = fs * 0.5, h = fs * 1.5, ptr = 6 * dpr;
    const bx = Math.max(geo.dx, Math.min(geo.dx + geo.dw - tw - padX * 2, cx - tw / 2 - padX));
    const by = Math.max(geo.dy + 2 * dpr, cy - h - ptr);
    ctx.fillStyle = "rgba(0,0,0,.65)";
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, tw + padX * 2, h, h / 2) : ctx.rect(bx, by, tw + padX * 2, h); ctx.fill();
    ctx.fillStyle = PLAYER_COLORS[slot] || "#fff"; ctx.fillRect(bx + h / 2, by + h - 2 * dpr, tw + padX * 2 - h, 2 * dpr);
    ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(name, bx + padX, by + h / 2);
    // pointer down to the head
    ctx.fillStyle = "rgba(0,0,0,.65)"; ctx.beginPath();
    ctx.moveTo(cx - 5 * dpr, by + h); ctx.lineTo(cx + 5 * dpr, by + h); ctx.lineTo(cx, by + h + ptr); ctx.fill();
  }
};
