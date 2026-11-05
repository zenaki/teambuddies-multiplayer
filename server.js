// Team Buddies Web — static file server + WebSocket signaling for browser multiplayer.
// The game disc is never uploaded here: the host loads it from their own disk in the browser,
// and gameplay is streamed peer-to-peer (WebRTC). This server only relays connection setup.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8080);
const MAX_GUESTS = 3; // Team Buddies supports 4 players via multitap: host = P1, guests = P2..P4

const ROOTS = [
  ["/ejs/cores/", path.dirname(require.resolve("@emulatorjs/core-pcsx_rearmed/package.json"))],
  ["/ejs/", path.join(path.dirname(require.resolve("@emulatorjs/emulatorjs/package.json")), "data")],
  ["/vendor/", path.join(path.dirname(require.resolve("peerjs/package.json")), "dist")],
  ["/", path.join(__dirname, "public")],
];
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".wasm": "application/wasm", ".data": "application/octet-stream",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

// ICE servers for WebRTC. STUN is enough on most home networks; set TURN_* env vars for strict NATs.
function iceConfig() {
  const ice = [{ urls: (process.env.STUN_URLS || "stun:stun.l.google.com:19302").split(",") }];
  if (process.env.TURN_URL) {
    ice.push({ urls: process.env.TURN_URL.split(","), username: process.env.TURN_USER || "", credential: process.env.TURN_PASS || "" });
  }
  return { signaling: "websocket", iceServers: ice };
}

// The npm build of EmulatorJS ships only unminified sources; its loader first asks for
// emulator.min.js/.css and logs 404s before falling back. Serve a concatenated bundle instead.
const EJS_DATA = ROOTS[1][1];
const EJS_BUNDLE = {
  "/ejs/emulator.min.js": [MIME[".js"], Buffer.from(
    ["emulator.js", "nipplejs.js", "shaders.js", "storage.js", "gamepad.js", "GameManager.js", "socket.io.min.js", "compression.js"]
      .map(f => fs.readFileSync(path.join(EJS_DATA, "src", f), "utf8")).join("\n;\n"))],
  "/ejs/emulator.min.css": [MIME[".css"], fs.readFileSync(path.join(EJS_DATA, "emulator.css"))],
};

function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let pathname = decodeURIComponent(url.pathname);
  if (EJS_BUNDLE[pathname]) {
    const [type, body] = EJS_BUNDLE[pathname];
    res.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": "public, max-age=86400" });
    return res.end(req.method === "HEAD" ? undefined : body);
  }
  if (pathname === "/config.json") {
    res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
    return res.end(JSON.stringify(iceConfig()));
  }
  if (pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (pathname.endsWith("/")) pathname += "index.html";
  for (const [prefix, dir] of ROOTS) {
    if (!pathname.startsWith(prefix)) continue;
    const file = path.normalize(path.join(dir, pathname.slice(prefix.length)));
    if (!file.startsWith(dir + path.sep)) break; // path traversal guard
    return fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Content-Length": st.size,
        "Cache-Control": prefix === "/" ? "no-cache" : "public, max-age=86400",
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }
  res.writeHead(404); res.end("Not found");
}

// ---- Signaling -------------------------------------------------------------
// rooms: code -> { host: ws, guests: Map<peerId, {ws, name, slot}> }
const rooms = new Map();
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newRoomCode() {
  for (;;) {
    let c = "";
    for (const b of crypto.randomBytes(5)) c += CODE_ALPHABET[b % CODE_ALPHABET.length];
    if (!rooms.has(c)) return c;
  }
}
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function roster(room) {
  return [...room.guests.entries()].map(([id, g]) => ({ id, name: g.name, slot: g.slot }));
}

function onMessage(ws, msg) {
  switch (msg.type) {
    case "host": {
      if (ws.room) return;
      const code = newRoomCode();
      rooms.set(code, { host: ws, guests: new Map() });
      ws.room = code; ws.role = "host";
      return send(ws, { type: "hosted", room: code });
    }
    case "join": {
      if (ws.room) return;
      const code = String(msg.room || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: "error", error: "Room tidak ditemukan" });
      if (room.guests.size >= MAX_GUESTS) return send(ws, { type: "error", error: "Room penuh (maks 4 pemain)" });
      const used = new Set([...room.guests.values()].map(g => g.slot));
      let slot = 2; while (used.has(slot)) slot++;
      const id = crypto.randomBytes(6).toString("hex");
      const name = String(msg.name || `Player ${slot}`).slice(0, 24);
      room.guests.set(id, { ws, name, slot });
      ws.room = code; ws.role = "guest"; ws.peerId = id;
      send(ws, { type: "joined", room: code, id, slot });
      send(room.host, { type: "guest-joined", id, name, slot });
      return send(room.host, { type: "roster", guests: roster(room) });
    }
    case "signal": {
      const room = rooms.get(ws.room);
      if (!room) return;
      if (ws.role === "host") {
        const g = room.guests.get(msg.to);
        if (g) send(g.ws, { type: "signal", data: msg.data });
      } else {
        send(room.host, { type: "signal", from: ws.peerId, data: msg.data });
      }
      return;
    }
    case "kick": {
      const room = rooms.get(ws.room);
      if (!room || ws.role !== "host") return;
      const g = room.guests.get(msg.id);
      if (g) { send(g.ws, { type: "error", error: "Dikeluarkan oleh host" }); g.ws.close(); }
      return;
    }
  }
}

function onClose(ws) {
  const room = rooms.get(ws.room);
  if (!room) return;
  if (ws.role === "host") {
    for (const g of room.guests.values()) { send(g.ws, { type: "host-left" }); g.ws.close(); }
    rooms.delete(ws.room);
  } else if (room.guests.delete(ws.peerId)) {
    send(room.host, { type: "guest-left", id: ws.peerId });
    send(room.host, { type: "roster", guests: roster(room) });
  }
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 256 * 1024 });
wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg && typeof msg.type === "string") onMessage(ws, msg);
  });
  ws.on("close", () => onClose(ws));
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 15000).unref();

server.listen(PORT, () => console.log(`Team Buddies Web: http://localhost:${PORT}`));
