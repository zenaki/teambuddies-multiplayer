// Shared code for host & guest pages.
"use strict";

// libretro joypad ids (EmulatorJS simulateInput indices 0..15)
const BTN = { CROSS: 0, SQUARE: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
              CIRCLE: 8, TRIANGLE: 9, L1: 10, R1: 11, L2: 12, R2: 13, L3: 14, R3: 15 };

// Same keyboard layout as EmulatorJS' default player-1 controls, so host & guests feel identical.
const KEYMAP = {
  "x": BTN.CROSS, "z": BTN.CIRCLE, "s": BTN.SQUARE, "a": BTN.TRIANGLE,
  "v": BTN.SELECT, "enter": BTN.START,
  "arrowup": BTN.UP, "arrowdown": BTN.DOWN, "arrowleft": BTN.LEFT, "arrowright": BTN.RIGHT,
  "q": BTN.L1, "e": BTN.R1, "tab": BTN.L2, "r": BTN.R2,
};
const KEY_AXES = { "h": [0, +1], "f": [0, -1], "g": [1, +1], "t": [1, -1],   // left stick
                   "l": [2, +1], "j": [2, -1], "k": [3, +1], "i": [3, -1] }; // right stick

// W3C "standard" gamepad layout -> PSX button
const PAD_BUTTONS = [BTN.CROSS, BTN.CIRCLE, BTN.SQUARE, BTN.TRIANGLE, BTN.L1, BTN.R1, BTN.L2, BTN.R2,
                     BTN.SELECT, BTN.START, BTN.L3, BTN.R3, BTN.UP, BTN.DOWN, BTN.LEFT, BTN.RIGHT];

// ---- Input packet: 12 bytes, little endian --------------------------------
// u16 seq | u16 buttons bitmask | i16 lx | i16 ly | i16 rx | i16 ry   (axes in -32767..32767)
const InputPacket = {
  encode(seq, buttons, axes) {
    const b = new ArrayBuffer(12), v = new DataView(b);
    v.setUint16(0, seq & 0xffff, true); v.setUint16(2, buttons & 0xffff, true);
    for (let i = 0; i < 4; i++) v.setInt16(4 + i * 2, Math.max(-32767, Math.min(32767, axes[i] | 0)), true);
    return b;
  },
  decode(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength !== 12) return null;
    const v = new DataView(buf);
    return { seq: v.getUint16(0, true), buttons: v.getUint16(2, true),
             axes: [v.getInt16(4, true), v.getInt16(6, true), v.getInt16(8, true), v.getInt16(10, true)] };
  },
  // true if seq a is newer than b (16-bit wraparound)
  newer(a, b) { return ((a - b) & 0xffff) !== 0 && ((a - b) & 0xffff) < 0x8000; },
};

// ---- Signaling client --------------------------------------------------------
class Signal extends EventTarget {
  constructor() {
    super();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("Tidak bisa terhubung ke server signaling"));
    });
    this.ws.onmessage = e => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
    };
    this.ws.onclose = () => this.dispatchEvent(new CustomEvent("closed"));
  }
  send(msg) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  on(type, fn) { this.addEventListener(type, e => fn(e.detail)); }
}

// Same message protocol as server.js, but brokered by a PeerJS server, so the app can be
// hosted as plain static files (e.g. GitHub Pages). The host registers peer id "<prefix><ROOM>";
// guests open a PeerJS data connection to it, and the host plays the role of server.js.
class PeerSignal extends EventTarget {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.opts = Object.assign({ config: { iceServers: cfg.iceServers } }, cfg.peer || {});
    this.prefix = cfg.peerPrefix || "tbweb-";
    this.conns = new Map(); // host: guestId -> { conn, name, slot }
    this.ready = Promise.resolve();
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { this.addEventListener(type, e => fn(e.detail)); }
  send(msg) {
    if (msg.type === "host") return this.startHost();
    if (msg.type === "join") return this.startGuest(msg.room, msg.name);
    if (this.role === "host") {
      const g = this.conns.get(msg.to || msg.id);
      if (!g) return;
      if (msg.type === "signal") g.conn.send({ type: "signal", data: msg.data });
      if (msg.type === "kick") { g.conn.send({ type: "error", error: "Dikeluarkan oleh host" }); setTimeout(() => g.conn.close(), 200); }
    } else if (this.conn && this.conn.open) {
      this.conn.send(msg);
    }
  }
  startHost(attempt = 0) {
    this.role = "host";
    const code = Array.from(crypto.getRandomValues(new Uint8Array(5)), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    const peer = new Peer(this.prefix + code, this.opts);
    peer.on("open", () => { this.peer = peer; this.emit("hosted", { room: code }); });
    peer.on("error", e => {
      if (e.type === "unavailable-id" && attempt < 5) { peer.destroy(); this.startHost(attempt + 1); }
      else if (!this.peer) this.emit("closed", {});
    });
    peer.on("disconnected", () => peer.reconnect()); // keep the room code registered with the broker
    peer.on("connection", conn => this.onGuestConn(conn));
  }
  onGuestConn(conn) {
    const id = conn.connectionId;
    conn.on("data", msg => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "join" && !this.conns.has(id)) {
        if (this.conns.size >= 3) { conn.send({ type: "error", error: "Room penuh (maks 4 pemain)" }); setTimeout(() => conn.close(), 200); return; }
        const used = new Set([...this.conns.values()].map(g => g.slot));
        let slot = 2; while (used.has(slot)) slot++;
        const name = String(msg.name || `Player ${slot}`).slice(0, 24);
        this.conns.set(id, { conn, name, slot });
        conn.send({ type: "joined", id, slot });
        this.emit("guest-joined", { id, name, slot });
      } else if (msg.type === "signal" && this.conns.has(id)) {
        this.emit("signal", { from: id, data: msg.data });
      }
    });
    conn.on("close", () => { if (this.conns.delete(id)) this.emit("guest-left", { id }); });
  }
  startGuest(room, name) {
    this.role = "guest";
    const peer = this.peer = new Peer(this.opts);
    let joined = false;
    peer.on("open", () => {
      const conn = this.conn = peer.connect(this.prefix + String(room).toUpperCase(), { reliable: true, serialization: "json" });
      conn.on("open", () => conn.send({ type: "join", name }));
      conn.on("data", msg => { if (msg && msg.type) { if (msg.type === "joined") joined = true; this.emit(msg.type, msg); } });
      conn.on("close", () => this.emit(joined ? "host-left" : "error", joined ? {} : { error: "Room tidak ditemukan" }));
    });
    peer.on("error", e => this.emit("error", { error: e.type === "peer-unavailable" ? "Room tidak ditemukan" : "Gagal terhubung ke broker PeerJS (" + e.type + ")" }));
  }
}
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// config.json: served dynamically by server.js, or as a static file in the GitHub Pages build.
async function loadConfig() {
  try { const r = await fetch("config.json", { cache: "no-store" }); if (r.ok) return await r.json(); } catch {}
  return { signaling: "peerjs", iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };
}
async function createSignal(cfg) {
  if (cfg.signaling === "peerjs") {
    if (typeof Peer === "undefined") await new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = "vendor/peerjs.min.js"; s.onload = res;
      s.onerror = () => rej(new Error("Gagal memuat PeerJS")); document.head.appendChild(s);
    });
    return new PeerSignal(cfg);
  }
  const s = new Signal(); await s.ready; return s;
}
function inviteUrl(room) { return new URL(`play.html?room=${room}`, location.href).href; }

// ---- Minimal STORE (uncompressed) ZIP writer --------------------------------
// Lets the host pick loose .cue + .bin files; EmulatorJS then unpacks the zip and boots the .cue.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
async function crc32File(file, onProgress) {
  let crc = 0xffffffff; const CHUNK = 16 << 20;
  for (let off = 0; off < file.size; off += CHUNK) {
    const u8 = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
    for (let i = 0; i < u8.length; i++) crc = CRC_TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
    onProgress && onProgress(Math.min(file.size, off + CHUNK));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function buildStoreZip(files, onProgress) {
  const enc = new TextEncoder(), parts = [], central = [];
  const total = files.reduce((s, f) => s + f.size, 0); let done = 0, offset = 0;
  for (const f of files) {
    if (f.size >= 0xffffffff) throw new Error(`${f.name} terlalu besar untuk ZIP biasa`);
    const name = enc.encode(f.name);
    const crc = await crc32File(f, n => onProgress && onProgress((done + n) / total));
    done += f.size;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 10, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint32(14, crc, true); lh.setUint32(18, f.size, true);
    lh.setUint32(22, f.size, true); lh.setUint16(26, name.length, true);
    parts.push(lh.buffer, name, f);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 10, true);
    ch.setUint16(8, 0x0800, true); ch.setUint32(16, crc, true); ch.setUint32(20, f.size, true);
    ch.setUint32(24, f.size, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + f.size;
  }
  const cdSize = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new File([...parts, ...central, end.buffer], "game.zip", { type: "application/zip" });
}

const $ = sel => document.querySelector(sel);
function fmtBytes(n) { return n > 1 << 20 ? (n / (1 << 20)).toFixed(0) + " MB" : (n / 1024).toFixed(0) + " KB"; }
