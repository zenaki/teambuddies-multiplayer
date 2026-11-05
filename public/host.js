"use strict";
// Host: runs the emulator locally, streams video+audio to guests over WebRTC,
// and injects each guest's pad state as emulator player (slot - 1).

let pickedFiles = [];
const peers = new Map(); // peerId -> { pc, input, ctrl, slot, name, state, rtt }
let signal, rtcConfig, mediaStream;

// ---------- 1. File picking ----------
const drop = $("#drop"), fileInput = $("#file");
function setFiles(list) {
  pickedFiles = [...list];
  $("#fileList").innerHTML = pickedFiles.map(f => `<li>${f.name.replace(/[<&]/g, "")} — ${fmtBytes(f.size)}</li>`).join("");
  $("#setupErr").textContent = "";
  $("#startBtn").disabled = pickedFiles.length === 0;
}
fileInput.onchange = () => setFiles(fileInput.files);
drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); setFiles(e.dataTransfer.files); };

function setProgress(frac) {
  $("#prog").classList.remove("hidden");
  $("#prog > div").style.width = (frac * 100).toFixed(1) + "%";
}

async function prepareGameFile(files) {
  const ext = f => f.name.split(".").pop().toLowerCase();
  if (files.length === 1 && ["zip", "7z", "pbp", "chd"].includes(ext(files[0]))) return files[0];
  const cues = files.filter(f => ext(f) === "cue");
  if (cues.length === 0 && files.length > 1) throw new Error("Pilih juga file .cue-nya.");
  for (const cue of cues) { // make sure every track the .cue references was picked
    const names = [...(await cue.text()).matchAll(/FILE\s+"([^"]+)"/gi)].map(m => m[1].toLowerCase());
    const have = new Set(files.map(f => f.name.toLowerCase()));
    const missing = names.filter(n => !have.has(n));
    if (missing.length) throw new Error("File yang dirujuk .cue belum dipilih: " + missing.join(", "));
  }
  if (files.length === 1) return files[0];
  return buildStoreZip(files, setProgress); // EmulatorJS unpacks it and boots the .cue
}

// ---- Disc kept in this browser (OPFS) ----
let loadedFromCache = false;
async function showCachedDisc() {
  if (!DiscCache.supported()) return;
  const m = await DiscCache.meta();
  $("#cachedBox").classList.toggle("hidden", !m);
  if (m) {
    const size = m.files.reduce((s, f) => s + f.size, 0);
    $("#cachedInfo").textContent = `(${m.files.find(f => /\.cue$/i.test(f.name))?.name || m.files[0].name}, ${fmtBytes(size)})`;
  }
}
showCachedDisc();
$("#cachedPlay").onclick = async () => {
  $("#cachedPlay").disabled = true;
  try {
    const files = await DiscCache.files();
    if (!files) throw new Error("Disc tersimpan rusak atau tidak lengkap. Hapus lalu pilih file lagi.");
    loadedFromCache = true;
    // a single image (.chd/.pbp) goes straight to the emulator; cue+bin sets are wrapped in a zip
    const game = files.length === 1 ? files[0] : await buildStoreZip(files, setProgress);
    $("#setup").classList.add("hidden"); $("#session").classList.remove("hidden");
    startEmulator(game);
  } catch (e) { $("#setupErr").textContent = e.message; $("#cachedPlay").disabled = false; }
};
$("#cachedDel").onclick = async () => { await DiscCache.clear(); showCachedDisc(); };

// After a boot from picked files, copy the unpacked .cue/.bin out of the emulator into OPFS.
async function cacheDisc() {
  if (loadedFromCache || !DiscCache.supported()) return;
  const say = t => { $("#discStatus").textContent = t; };
  try {
    const FS = emu().gameManager.FS, cueName = String(emu().fileName || "").replace(/^\//, "");
    if (/\.(chd|pbp)$/i.test(cueName)) { // single-file image: keep it as is
      const node = FS.lookupPath("/" + cueName).node;
      await DiscCache.save([{ name: cueName.split("/").pop(), data: node.contents.subarray(0, node.usedBytes) }], p => say(`Menyimpan disc di browser… ${Math.round(p * 100)}%`));
      say("💾 Disc tersimpan di browser ini. Lain kali tinggal klik \"Main dengan disc tersimpan\".");
      return;
    }
    if (!/\.cue$/i.test(cueName)) return;
    const cueBytes = FS.readFile("/" + cueName);
    const dir = cueName.includes("/") ? cueName.slice(0, cueName.lastIndexOf("/") + 1) : "";
    const tracks = [...new TextDecoder().decode(cueBytes).matchAll(/FILE\s+"([^"]+)"/gi)].map(m => m[1]);
    const entries = [{ name: cueName.split("/").pop(), data: cueBytes }];
    for (const t of tracks) {
      const node = FS.lookupPath("/" + dir + t).node;
      entries.push({ name: t, data: node.contents.subarray(0, node.usedBytes) });
    }
    const need = entries.reduce((s, e) => s + e.data.length, 0);
    const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
    if (est && est.quota - est.usage < need * 1.05) { say("Ruang penyimpanan browser tidak cukup untuk menyimpan disc."); return; }
    if (navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await DiscCache.save(entries, p => say(`Menyimpan disc di browser… ${Math.round(p * 100)}%`));
    say("💾 Disc tersimpan di browser ini. Lain kali tinggal klik \"Main dengan disc tersimpan\".");
  } catch (e) { say("Disc tidak bisa disimpan di browser: " + e.message); }
}

$("#startBtn").onclick = async () => {
  $("#startBtn").disabled = true;
  try {
    const game = await prepareGameFile(pickedFiles);
    $("#setup").classList.add("hidden");
    $("#session").classList.remove("hidden");
    startEmulator(game);
  } catch (e) {
    $("#setupErr").textContent = e.message;
    $("#startBtn").disabled = false;
  }
};

// ---------- 2. Emulator ----------
// If the tab dies while loading the disc (phones kill tabs that use too much memory and reload
// them), the next load finds this flag and explains what happened.
try {
  if (sessionStorage.getItem("tb-booting")) {
    sessionStorage.removeItem("tb-booting");
    $("#setupErr").textContent = "Halaman termuat ulang saat memuat disc: browser kemungkinan kehabisan memori (sering terjadi di HP/iPad). " +
      "Jadikan komputer/laptop sebagai host, lalu main di HP sebagai tamu lewat link undangan.";
  }
} catch {}

function startEmulator(gameFile) {
  try { sessionStorage.setItem("tb-booting", "1"); } catch {}
  Object.assign(window, {
    EJS_player: "#game",
    EJS_core: "pcsx_rearmed",          // HLE BIOS built in, no Sony BIOS file needed
    EJS_pathtodata: "ejs/",
    EJS_gameUrl: gameFile,             // a local File object, never uploaded
    EJS_gameName: "Team Buddies",
    EJS_startOnLoaded: true,
    EJS_CacheLimit: 0,                 // don't copy a 500 MB disc into IndexedDB
    EJS_color: "#f5b301",
    EJS_defaultOptions: { "pcsx_rearmed_multitap": "port 1" }, // players 1-4 on a multitap in port 1
    EJS_onGameStart: onGameStart,
  });
  const s = document.createElement("script");
  s.src = "ejs/loader.js";
  document.body.appendChild(s);
}

function emu() { return window.EJS_emulator; }

// Video from the emulator canvas + audio tapped from Emscripten's OpenAL graph.
function buildMediaStream() {
  const canvas = emu().canvas;
  const video = canvas.captureStream(60).getVideoTracks()[0];
  if (video) video.contentHint = "motion";
  const stream = new MediaStream(video ? [video] : []);
  const AL = emu().Module && emu().Module.AL;
  const ctx = AL && AL.currentCtx && AL.currentCtx.audioCtx;
  if (ctx) {
    const dest = ctx.createMediaStreamDestination();
    const tapped = new WeakSet();
    const tapSources = () => { // OpenAL sources can appear after boot, so keep looking
      const srcs = (AL.currentCtx && AL.currentCtx.sources) || {};
      for (const k in srcs) {
        const g = srcs[k] && srcs[k].gain;
        if (g && !tapped.has(g)) { g.connect(dest); tapped.add(g); }
      }
    };
    tapSources(); setInterval(tapSources, 2000);
    stream.addTrack(dest.stream.getAudioTracks()[0]);
  }
  return stream;
}

let detector, hostView, currentLayout = "full";
let hostName = "";
try { hostName = localStorage.getItem("tb-name") || ""; } catch {}
$("#hostName").value = hostName;
$("#hostName").oninput = e => { hostName = e.target.value.trim(); try { localStorage.setItem("tb-name", hostName); } catch {} };
// slot -> display name for every human player; viewports without an entry are bots
function playerNames() {
  const n = { 1: hostName || "Host" };
  for (const p of peers.values()) if (p.pc.connectionState !== "failed") n[p.slot] = p.name;
  return n;
}
function sendNames() { const names = playerNames(); if (hostView) hostView.setNames(names); broadcast({ t: "names", names }); }
function setupFocusView() {
  const lv = $("#localVideo");
  lv.srcObject = new MediaStream(mediaStream.getVideoTracks());
  lv.play().catch(() => {});
  hostView = new FocusView(lv, $("#focusCanvas"));
  hostView.slot = 1;
  detector = new LayoutDetector(lv, layout => {
    currentLayout = layout;
    hostView.layout = layout;
    $("#layoutTag").textContent = { full: "penuh", h2: "2P", quad: "4P", quad3: "3P" }[layout] || layout;
    updateOverlay();
    broadcast({ t: "layout", layout });
  });
  hostView.setNames(playerNames());
  hostView.tagDelay = 35; // the local preview video lags the emulator by ~2 frames
  startTagLoop();
}

// Name tags: read the buddies' positions from the game's memory ~30x/s and project them into
// every viewport (gamemem.js). Falls back to fixed points if the memory can't be read.
const gameMem = new GameMemory(() => emu() && emu().Module);
let tagsWereSent = false;
function startTagLoop() {
  setInterval(() => {
    if (currentLayout === "full") {
      if (tagsWereSent) { hostView.pushTags([]); broadcastTags([]); tagsWereSent = false; }
      return;
    }
    let tags = gameMem.tags();
    if (tags === null) tags = fallbackTags(currentLayout);
    hostView.pushTags(tags);
    broadcastTags(tags);
    tagsWereSent = true;
  }, 33);
}
function broadcastTags(tags) {
  const s = JSON.stringify(tags.map(t => [t[0], Math.round(t[1] * 1e4), Math.round(t[2] * 1e4), t[3]]));
  for (const p of peers.values()) if (p.tags && p.tags.readyState === "open") p.tags.send(s);
}
// Only cover the emulator canvas when a split-screen is on and focus is wanted;
// menus keep the direct (zero extra latency) emulator canvas.
function updateOverlay() {
  const show = hostView && currentLayout !== "full"; // focus off still shows the full frame with name tags
  $("#focusCanvas").classList.toggle("hidden", !show);
}
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const p of peers.values()) if (p.ctrl && p.ctrl.readyState === "open") p.ctrl.send(s);
}
$("#focusBtn").onclick = () => {
  hostView.focus = !hostView.focus;
  $("#focusBtn").classList.toggle("on", hostView.focus);
  $("#focusBtn").setAttribute("aria-pressed", hostView.focus);
  updateOverlay();
};
$("#radarChk").onchange = e => { if (hostView) hostView.radar = e.target.checked; };
$("#tagsChk").onchange = e => { if (hostView) hostView.showTags = e.target.checked; };
$("#layoutSel").onchange = e => detector && detector.setOverride(e.target.value);

async function onGameStart() {
  try { sessionStorage.removeItem("tb-booting"); } catch {}
  mediaStream = buildMediaStream();
  setTimeout(cacheDisc, 3000); // let the game settle first
  setupFocusView();
  const cfg = await loadConfig();
  rtcConfig = { iceServers: cfg.iceServers };
  try { signal = await createSignal(cfg); } catch (e) { $("#netStatus").textContent = e.message; return; }
  signal.on("hosted", ({ room }) => {
    $("#roomCode").textContent = room;
    $("#inviteUrl").value = inviteUrl(room);
    $("#netStatus").textContent = "Room aktif · biarkan tab ini tetap terlihat saat bermain";
  });
  signal.on("guest-joined", g => connectGuest(g));
  signal.on("guest-left", ({ id }) => dropGuest(id));
  signal.on("signal", ({ from, data }) => onSignal(from, data));
  signal.on("closed", () => { $("#netStatus").textContent = "Terputus dari server signaling"; });
  $("#netStatus").textContent = "Membuka room…";
  signal.send({ type: "host" });
}

$("#copyBtn").onclick = () => {
  navigator.clipboard.writeText($("#inviteUrl").value).then(() => { $("#copyBtn").textContent = "Tersalin"; setTimeout(() => $("#copyBtn").textContent = "Salin link", 1500); });
};

// ---------- 3. WebRTC per guest ----------
async function connectGuest({ id, name, slot }) {
  const pc = new RTCPeerConnection(rtcConfig);
  const peer = { pc, slot, name, rtt: null, lastSeen: 0, state: { seq: -1, buttons: 0, axes: [0, 0, 0, 0] } };
  peers.set(id, peer);
  setTimeout(sendNames, 0);

  for (const track of mediaStream.getTracks()) pc.addTrack(track, mediaStream);
  peer.input = pc.createDataChannel("input", { ordered: false, maxRetransmits: 0 });
  peer.input.binaryType = "arraybuffer";
  peer.input.onmessage = e => applyInput(peer, InputPacket.decode(e.data));
  peer.tags = pc.createDataChannel("tags", { ordered: false, maxRetransmits: 0 });
  peer.ctrl = pc.createDataChannel("ctrl");
  peer.ctrl.onopen = () => peer.ctrl.send(JSON.stringify({ t: "welcome", slot, layout: currentLayout, names: playerNames() }));
  peer.ctrl.onmessage = e => {
    peer.lastSeen = performance.now();
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === "ping") peer.ctrl.send(JSON.stringify({ t: "pong", ts: m.ts }));
    else if (m.t === "rtt") { peer.rtt = m.ms | 0; renderPlayers(); }
  };
  pc.onicecandidate = e => e.candidate && signal.send({ type: "signal", to: id, data: { candidate: e.candidate } });
  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) releaseAll(peer);
    renderPlayers();
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signal.send({ type: "signal", to: id, data: { sdp: pc.localDescription } });
  renderPlayers();
}

async function onSignal(from, data) {
  const peer = peers.get(from);
  if (!peer) return;
  if (data.sdp) {
    await peer.pc.setRemoteDescription(data.sdp);
    tuneVideoSender(peer.pc);
  } else if (data.candidate) {
    try { await peer.pc.addIceCandidate(data.candidate); } catch {}
  }
}

function tuneVideoSender(pc) {
  for (const s of pc.getSenders()) {
    if (!s.track || s.track.kind !== "video") continue;
    const p = s.getParameters();
    p.degradationPreference = "maintain-framerate";
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = 4_000_000;
    p.encodings[0].maxFramerate = 60;
    s.setParameters(p).catch(() => {});
  }
}

// Heartbeat: guests ping every second. A browser that vanishes without closing its connection
// is only noticed by WebRTC after ~30 s, so free the slot after 6 s of silence instead.
setInterval(() => {
  const now = performance.now();
  for (const [id, p] of peers) {
    if (p.lastSeen && now - p.lastSeen > 6000) { signal.send({ type: "kick", id }); dropGuest(id); }
  }
}, 2000);

function dropGuest(id) {
  setTimeout(sendNames, 0);
  const peer = peers.get(id);
  if (!peer) return;
  releaseAll(peer);
  peer.pc.close();
  peers.delete(id);
  renderPlayers();
}

// ---------- 4. Input injection ----------
const AXIS_IDX = [[16, 17], [18, 19], [20, 21], [22, 23]]; // [positive, negative] per axis lx, ly, rx, ry
function applyInput(peer, pkt) {
  if (!pkt || !emu() || !emu().gameManager) return;
  const st = peer.state;
  if (st.seq >= 0 && !InputPacket.newer(pkt.seq, st.seq)) return; // stale/reordered packet
  st.seq = pkt.seq;
  const player = peer.slot - 1, gm = emu().gameManager;
  const changed = pkt.buttons ^ st.buttons;
  for (let b = 0; b < 16; b++) if (changed & (1 << b)) gm.simulateInput(player, b, (pkt.buttons >> b) & 1);
  st.buttons = pkt.buttons;
  for (let a = 0; a < 4; a++) {
    if (pkt.axes[a] === st.axes[a]) continue;
    const v = pkt.axes[a], [pos, neg] = AXIS_IDX[a];
    gm.simulateInput(player, pos, v > 0 ? v : 0);
    gm.simulateInput(player, neg, v < 0 ? -v : 0);
    st.axes[a] = v;
  }
}
function releaseAll(peer) { // never leave a disconnected player holding a button
  applyInput(peer, { seq: (peer.state.seq + 1) & 0xffff, buttons: 0, axes: [0, 0, 0, 0] });
}

// ---------- 5. Player list ----------
function renderPlayers() {
  const rows = [`<li><span class="dot p1"></span><span class="name">${(hostName || "Host").replace(/[<&]/g, "")} (kamu)</span><span class="pill">P1</span></li>`];
  for (const [id, p] of [...peers.entries()].sort((a, b) => a[1].slot - b[1].slot)) {
    const st = p.pc.connectionState;
    const cls = st === "connected" ? "ok" : (st === "failed" ? "bad" : "");
    const label = st === "connected" ? (p.rtt != null ? `${p.rtt} ms` : "terhubung") : st;
    rows.push(`<li><span class="dot p${p.slot}"></span><span class="name">${p.name.replace(/[<&]/g, "")}</span>
      <span class="pill ${cls}">${label}</span><span class="pill">P${p.slot}</span>
      <button class="small" data-kick="${id}">Keluarkan</button></li>`);
  }
  $("#players").innerHTML = rows.join("");
}
$("#players").onclick = e => {
  const id = e.target.dataset && e.target.dataset.kick;
  if (id) { signal.send({ type: "kick", id }); dropGuest(id); }
};
