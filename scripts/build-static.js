// Builds a fully static copy of the app into ./dist for GitHub Pages (or any static host).
// Signaling uses PeerJS (public broker by default) instead of server.js' WebSocket.
//   node scripts/build-static.js
// Optional env: PEER_HOST, PEER_PORT, PEER_PATH, PEER_SECURE (own PeerServer),
//               STUN_URLS, TURN_URL, TURN_USER, TURN_PASS
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist");
const pkgDir = name => path.dirname(require.resolve(`${name}/package.json`, { paths: [ROOT] }));
const EJS_DATA = path.join(pkgDir("@emulatorjs/emulatorjs"), "data");

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, "public"), OUT, { recursive: true });

// EmulatorJS runtime + PSX core
fs.cpSync(EJS_DATA, path.join(OUT, "ejs"), { recursive: true });
const core = pkgDir("@emulatorjs/core-pcsx_rearmed");
fs.mkdirSync(path.join(OUT, "ejs/cores/reports"), { recursive: true });
for (const f of fs.readdirSync(core)) if (f.endsWith(".data")) fs.copyFileSync(path.join(core, f), path.join(OUT, "ejs/cores", f));
fs.copyFileSync(path.join(core, "reports/pcsx_rearmed.json"), path.join(OUT, "ejs/cores/reports/pcsx_rearmed.json"));
// The npm package has no minified bundle; build one so the loader doesn't log 404s.
const scripts = ["emulator.js", "nipplejs.js", "shaders.js", "storage.js", "gamepad.js", "GameManager.js", "socket.io.min.js", "compression.js"];
fs.writeFileSync(path.join(OUT, "ejs/emulator.min.js"), scripts.map(f => fs.readFileSync(path.join(EJS_DATA, "src", f), "utf8")).join("\n;\n"));
fs.copyFileSync(path.join(EJS_DATA, "emulator.css"), path.join(OUT, "ejs/emulator.min.css"));

// PeerJS client
fs.mkdirSync(path.join(OUT, "vendor"), { recursive: true });
fs.copyFileSync(path.join(pkgDir("peerjs"), "dist/peerjs.min.js"), path.join(OUT, "vendor/peerjs.min.js"));

// Runtime config
const ice = [{ urls: (process.env.STUN_URLS || "stun:stun.l.google.com:19302").split(",") }];
if (process.env.TURN_URL) ice.push({ urls: process.env.TURN_URL.split(","), username: process.env.TURN_USER || "", credential: process.env.TURN_PASS || "" });
const peer = {};
if (process.env.PEER_HOST) {
  peer.host = process.env.PEER_HOST;
  if (process.env.PEER_PORT) peer.port = Number(process.env.PEER_PORT);
  peer.path = process.env.PEER_PATH || "/";
  peer.secure = process.env.PEER_SECURE !== "false";
}
fs.writeFileSync(path.join(OUT, "config.json"), JSON.stringify({ signaling: "peerjs", peerPrefix: "tbweb-", peer, iceServers: ice }, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, ".nojekyll"), ""); // serve files as-is

let bytes = 0, files = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } })(OUT);
console.log(`dist/ ready: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
