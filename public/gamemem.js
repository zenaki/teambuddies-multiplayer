"use strict";
// Reads Team Buddies (NTSC-U, SLUS-00869) battle state straight from the emulated PS1 RAM and
// projects every player-controlled buddy's head into every split-screen viewport, exactly the way
// the game's GTE does, so name tags can sit on the characters themselves.
//
// Reverse-engineered layout (all addresses are PS1 RAM, KSEG0):
//   units      0x80110000 + i*0x3A4, i = 0..15   (4 teams x 4 buddies)
//     +0x84  int16 x,y,z   position used for the frame being drawn (+0x60 = current)
//     +0x2BC u32           -> controlling player struct, 0 when AI controlled
//   players    0x800BA764 + k*0x13C, k = 0..3    (k = multitap slot, P1 = 0)
//   cameras    0x800BDD4C + v*0x78               int16 x,y,z, +0x08 int16 pitch (4096 = 360 deg)
//   viewports  0x800BE028 + v*0x24               int16 ox,oy,w,h, +0x14 int32 H (GTE focal length)
// Projection (from the game's viewport setup at ENG 0x800AA968): OFX = w/2, OFY = h/2,
//   x' = dx, y' = dy*cos(p) + dz*sin(p), z' = -dy*sin(p) + dz*cos(p),
//   sx = OFX + H*x'/z', sy = OFY + (H/2)*y'/z'   (240-line mode: pixels are 2:1)
// The picture is drawn 4 lines below the framebuffer top. Verified against frames: +-0.7 px
// vertically, +-2.6 px horizontally (the dome's centre wobbles with the walk animation).

const GM = {
  RAM_SIZE: 0x200000,
  UNITS: 0x110000, UNIT_STRIDE: 0x3A4, UNIT_COUNT: 16,
  U_POS_DRAWN: 0x84, U_CTRL: 0x2BC,
  PLAYER_BASE: 0x800BA764, PLAYER_STRIDE: 0x13C,
  CAMS: 0x0BDD4C, CAM_STRIDE: 0x78, CAM_PITCH: 0x08,
  VPS: 0x0BE028, VP_STRIDE: 0x24, VP_H: 0x14,
  DISPLAY_Y: 4,       // framebuffer lines above the picture
  HEAD: 600,          // world units above the position: dome top is ~545, label sits just above it
  FRAME_W: 640, FRAME_H: 240,
  SIG_EXE: [0x5c, 0x4f, 0x56, 0x45, 0x52, 0x4c, 0x41, 0x59, 0x2e, 0x44, 0x41, 0x54, 0x3b, 0x31], // "\OVERLAY.DAT;1" @0x14DEC
  SIG_OVL: [0x5c, 0x5c, 0x53, 0x59, 0x53, 0x2e, 0x42, 0x49, 0x4e, 0x3b, 0x31],                   // "\\SYS.BIN;1"    @0x10004
};

class GameMemory {
  constructor(getModule) {
    this.getModule = getModule;
    this.base = -1; this.searching = false; this.failed = false;
  }
  heap() { const M = this.getModule(); return M && M.HEAPU8; }
  matches(H, at, sig) {
    if (at < 0 || at + sig.length > H.length) return false;
    for (let i = 0; i < sig.length; i++) if (H[at + i] !== sig[i]) return false;
    return true;
  }
  valid(H, base) { return this.matches(H, base + 0x14DEC, GM.SIG_EXE) && this.matches(H, base + 0x10004, GM.SIG_OVL); }
  // The emulator's PS1 RAM is one 2 MB block somewhere in the WASM heap. The disc image is also in
  // the heap and contains the same EXE bytes, so the hit is confirmed with the OVERLAY.DAT copy that
  // only exists in live RAM. Searched in chunks so the page never stalls.
  locate() {
    if (this.searching || this.base >= 0) return;
    const H = this.heap(); if (!H) return;
    this.searching = true;
    const u32 = new Uint32Array(H.buffer, H.byteOffset, H.length >>> 2);
    const s = GM.SIG_EXE, first = (s[0] | s[1] << 8 | s[2] << 16 | s[3] << 24) >>> 0;
    let i = 0;
    const step = () => {
      const end = Math.min(u32.length, i + (8 << 20));
      for (; i < end; i++) {
        if (u32[i] !== first) continue;
        const base = i * 4 - 0x14DEC;
        if (base >= 0 && this.valid(H, base)) { this.base = base; this.searching = false; return; }
      }
      if (i >= u32.length) { this.searching = false; this.failed = true; return; }
      setTimeout(step, 0);
    };
    step();
  }
  view() {
    const H = this.heap();
    if (!H || this.base < 0) { this.locate(); return null; }
    if (!this.valid(H, this.base)) { this.base = -1; this.failed = false; this.locate(); return null; }
    if (!this.dv || this.dv.buffer !== H.buffer) this.dv = new DataView(H.buffer, H.byteOffset + this.base, GM.RAM_SIZE);
    return this.dv;
  }
  // -> [[slot, fx, fy, viewport], ...] with fx/fy as fractions of the video frame, or null if unreadable
  tags() {
    const dv = this.view();
    if (!dv) return null;
    const out = [];
    for (let v = 0; v < 4; v++) {
      const vp = GM.VPS + v * GM.VP_STRIDE;
      const ox = dv.getInt16(vp, true), oy = dv.getInt16(vp + 2, true);
      const w = dv.getInt16(vp + 4, true), h = dv.getInt16(vp + 6, true), focal = dv.getInt32(vp + GM.VP_H, true);
      if (w <= 0 || h <= 0 || w > 1024 || h > 512 || focal < 100 || focal > 4000) continue;
      const cam = GM.CAMS + v * GM.CAM_STRIDE;
      const cx = dv.getInt16(cam, true), cy = dv.getInt16(cam + 2, true), cz = dv.getInt16(cam + 4, true);
      const th = dv.getInt16(cam + GM.CAM_PITCH, true) * Math.PI * 2 / 4096, cs = Math.cos(th), sn = Math.sin(th);
      for (let u = 0; u < GM.UNIT_COUNT; u++) {
        const ub = GM.UNITS + u * GM.UNIT_STRIDE;
        const ctrl = dv.getUint32(ub + GM.U_CTRL, true);
        if (!ctrl) continue; // AI controlled
        const k = (ctrl - GM.PLAYER_BASE) / GM.PLAYER_STRIDE;
        if (!Number.isInteger(k) || k < 0 || k > 3) continue;
        const px = dv.getInt16(ub + GM.U_POS_DRAWN, true), py = dv.getInt16(ub + GM.U_POS_DRAWN + 2, true), pz = dv.getInt16(ub + GM.U_POS_DRAWN + 4, true);
        if (!px && !py && !pz) continue;
        const dx = px - cx, dy = py - GM.HEAD - cy, dz = pz - cz;
        const yc = dy * cs + dz * sn, zc = -dy * sn + dz * cs;
        if (zc < 300) continue; // behind / too close to the camera
        const sx = (w >> 1) + focal * dx / zc, sy = (h >> 1) + (focal / 2) * yc / zc;
        if (sx < 0 || sx > w || sy < -h * 0.15 || sy > h) continue; // label may poke slightly above its viewport
        out.push([k + 1, (ox + sx) / GM.FRAME_W, (oy + GM.DISPLAY_Y + Math.max(0, sy)) / GM.FRAME_H, v]);
      }
    }
    return out;
  }
}
