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

// ---- Name tags above the controlled buddy -------------------------------------
// The game marks each player's controlled buddy with a red/yellow triangle under its feet.
// The host finds it in every split viewport (full-res frame) and broadcasts the positions;
// clients draw the owner's name above it. Viewports nobody owns (bots) get no tag.
const PLAYER_COLORS = { 1: "#4aa3ff", 2: "#ff5d5d", 3: "#3ccf7a", 4: "#f5b301" };
const TAG_LIFT = { quad: 0.075, quad3: 0.075, h2: 0.135 }; // capsule height above the triangle, frame fraction

function findMarkers(source, ctx, layout) {
  const rects = LAYOUTS[layout] || {}, out = {};
  if (!Object.keys(rects).length) return out;
  ctx.drawImage(source, 0, 0, DET_W, DET_H);
  const px = ctx.getImageData(0, 0, DET_W, DET_H).data;
  const at = (x, y) => (y * DET_W + x) * 4;
  // relative thresholds: the selector triangle pulses between bright and dim
  const isRed = i => px[i] > 130 && px[i + 1] < px[i] * 0.4 && px[i + 2] < px[i] * 0.3;
  const isYellow = i => px[i] > 130 && px[i + 1] > px[i] * 0.7 && px[i + 2] < px[i] * 0.5;
  for (const slot in rects) {
    const [fx0, fy0, fx1, fy1] = rects[slot];
    const x0 = Math.ceil(fx0 * DET_W) + 4, x1 = Math.floor(fx1 * DET_W) - 4;
    const y0 = Math.ceil(fy0 * DET_H) + 3, y1 = Math.floor(fy1 * DET_H) - 3;
    // Row runs of red flanked by yellow on both sides ("YYRRRRYY") = a row of the triangle.
    // Works for the red team too, whose red body would otherwise merge with the triangle.
    const segs = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!isRed(at(x, y))) continue;
        const s = x; while (x < x1 && isRed(at(x, y))) x++;
        const e = x - 1, n = e - s + 1;
        if (n < 2 || n > 40) continue;
        const yl = isYellow(at(s - 1, y)) || isYellow(at(s - 2, y)) || isYellow(at(s - 3, y));
        const yr = isYellow(at(e + 1, y)) || isYellow(at(e + 2, y)) || isYellow(at(e + 3, y));
        if (yl && yr) segs.push([(s + e) / 2, y, n]);
      }
    }
    const clusters = [];
    for (const sg of segs) {
      const c = clusters.find(c => { const l = c[c.length - 1]; return Math.abs(l[0] - sg[0]) < 10 && sg[1] - l[1] <= 4; });
      if (c) c.push(sg); else clusters.push([sg]);
    }
    const ok = clusters.filter(c => c.length >= 2 || c[0][2] >= 4);
    if (!ok.length) continue;
    const best = ok.reduce((a, b) => (b.length > a.length ? b : a));
    const cx = best.reduce((t, s) => t + s[0], 0) / best.length, top = Math.min(...best.map(s => s[1]));
    const lift = TAG_LIFT[layout] || 0.08;
    out[slot] = [+(cx / DET_W).toFixed(4), +Math.max(fy0 + 0.02, top / DET_H - lift).toFixed(4)];
  }
  return out;
}

class MarkerTracker {
  constructor(video, getLayout, onTags) {
    const c = document.createElement("canvas"); c.width = DET_W; c.height = DET_H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    let last = "{}", layoutWas = "";
    const seen = {}; // slot -> { pos, t }: keep a tag ~600 ms if the marker blinks or a frame is missed
    setInterval(() => {
      if (video.readyState < 2) return;
      const layout = getLayout(), now = performance.now();
      if (layout !== layoutWas) { for (const k in seen) delete seen[k]; layoutWas = layout; }
      const found = findMarkers(video, ctx, layout);
      for (const s in found) seen[s] = { pos: found[s], t: now };
      const tags = {};
      for (const s in seen) { if (now - seen[s].t < 600) tags[s] = seen[s].pos; else delete seen[s]; }
      const s = JSON.stringify(tags);
      if (s !== last || s !== "{}") onTags(tags);
      last = s;
    }, 100);
  }
}

// Drawing: FocusView keeps target positions from the host and eases towards them.
FocusView.prototype.setTags = function (tags) { this.tagTarget = tags || {}; };
FocusView.prototype.setNames = function (names) { this.names = names || {}; };
FocusView.prototype.drawTags = function (geo) {
  const tgt = this.tagTarget || {}, names = this.names || {};
  this.tagPos = this.tagPos || {};
  const ctx = this.ctx, dpr = devicePixelRatio || 1;
  for (const slot of Object.keys(this.tagPos)) if (!tgt[slot]) delete this.tagPos[slot];
  for (const slot in tgt) {
    const name = names[slot];
    if (!name) continue; // nobody owns this viewport -> bot, no tag
    const p = this.tagPos[slot] || (this.tagPos[slot] = tgt[slot].slice());
    p[0] += (tgt[slot][0] - p[0]) * 0.35; p[1] += (tgt[slot][1] - p[1]) * 0.35;
    const [x0, y0, x1, y1] = geo.rect;
    if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
    const cx = geo.dx + (p[0] - x0) / (x1 - x0) * geo.dw, cy = geo.dy + (p[1] - y0) / (y1 - y0) * geo.dh;
    const fs = Math.max(11 * dpr, Math.min(18 * dpr, geo.dh * 0.045));
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    const tw = ctx.measureText(name).width, padX = fs * 0.5, h = fs * 1.5;
    const bx = Math.max(geo.dx, Math.min(geo.dx + geo.dw - tw - padX * 2, cx - tw / 2 - padX)), by = Math.max(geo.dy + 2 * dpr, cy - h);
    ctx.fillStyle = "rgba(0,0,0,.65)";
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, tw + padX * 2, h, h / 2) : ctx.rect(bx, by, tw + padX * 2, h); ctx.fill();
    ctx.fillStyle = PLAYER_COLORS[slot] || "#fff"; ctx.fillRect(bx + h / 2, by + h - 2 * dpr, tw + padX * 2 - h, 2 * dpr);
    ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(name, bx + padX, by + h / 2);
    // little pointer
    ctx.fillStyle = "rgba(0,0,0,.65)"; ctx.beginPath();
    ctx.moveTo(cx - 5 * dpr, by + h); ctx.lineTo(cx + 5 * dpr, by + h); ctx.lineTo(cx, by + h + 6 * dpr); ctx.fill();
  }
};
