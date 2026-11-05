"use strict";
// Guest: receives the host's game stream and sends this player's pad state.

const params = new URLSearchParams(location.search);
$("#room").value = (params.get("room") || "").toUpperCase();
$("#name").value = params.get("name") || localStorageGet("tb-name") || "";
if ("ontouchstart" in window || matchMedia("(pointer: coarse)").matches) document.body.classList.add("is-touch");
document.addEventListener("touchmove", e => { if (document.body.classList.contains("playing")) e.preventDefault(); }, { passive: false });

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

let pc, inputCh, ctrlCh, signal, mySlot = 0, active = false;
const view = new FocusView($("#video"), $("#view"));
const LAYOUT_LABEL = { full: "Saat ini: layar penuh.", h2: "Saat ini: 2 pemain.", quad3: "Saat ini: 3 pemain.", quad: "Saat ini: 4 pemain." };
// the screen box takes the shape of what is shown (e.g. a wide strip in 2P), never taller than 4:3
function fitScreen() { $(".screen").style.aspectRatio = String(Math.max(4 / 3, view.aspect())); }
function setLayout(l) { view.layout = l; $("#layoutInfo").textContent = LAYOUT_LABEL[l] || ""; fitScreen(); }
try { view.focus = localStorage.getItem("tb-focus") !== "0"; view.radar = localStorage.getItem("tb-radar") !== "0"; } catch {}
$("#focusBtn").classList.toggle("on", view.focus); $("#radarChk").checked = view.radar;
$("#focusBtn").onclick = () => {
  view.focus = !view.focus;
  $("#focusBtn").classList.toggle("on", view.focus); $("#focusBtn").setAttribute("aria-pressed", view.focus);
  localStorageSet("tb-focus", view.focus ? "1" : "0");
  fitScreen();
};
$("#radarChk").onchange = e => { view.radar = e.target.checked; localStorageSet("tb-radar", view.radar ? "1" : "0"); };
$("#tagsChk").onchange = e => { view.showTags = e.target.checked; localStorageSet("tb-tags", e.target.checked ? "1" : "0"); };
try { view.showTags = localStorage.getItem("tb-tags") !== "0"; } catch {}
$("#tagsChk").checked = view.showTags;
const status = t => { $("#status").textContent = t; };

$("#joinForm").onsubmit = async e => {
  e.preventDefault();
  $("#err").textContent = "";
  const room = $("#room").value.trim().toUpperCase(), name = $("#name").value.trim();
  localStorageSet("tb-name", name);
  history.replaceState(null, "", `?room=${room}`);
  $("#joinForm").classList.add("hidden"); $("#waiting").classList.remove("hidden");
  try { await join(room, name); }
  catch (err) { fail(err.message); }
};

function fail(msg) {
  $("#err").textContent = msg;
  $("#joinForm").classList.remove("hidden"); $("#waiting").classList.add("hidden");
  $("#overlay").classList.remove("hidden"); $("#unmute").classList.add("hidden");
  status(msg);
}

async function join(room, name) {
  const cfg = await loadConfig();
  const rtcConfig = { iceServers: cfg.iceServers };
  signal = await createSignal(cfg);
  signal.on("error", ({ error }) => fail(error));
  signal.on("host-left", () => fail("Host menutup room"));
  signal.on("joined", ({ slot }) => {
    mySlot = slot; view.slot = slot; fitScreen();
    $("#you").textContent = $("#you2").textContent = `Kamu P${slot}`; $("#you").classList.remove("hidden");
    $("#waitMsg").textContent = "Menunggu stream dari host…";
    status(`Masuk room ${room} sebagai pemain ${slot}`);
  });
  signal.on("signal", async ({ data }) => {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signal.send({ type: "signal", data: { sdp: pc.localDescription } });
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch {}
    }
  });

  pc = new RTCPeerConnection(rtcConfig);
  pc.onicecandidate = e => e.candidate && signal.send({ type: "signal", data: { candidate: e.candidate } });
  pc.ontrack = e => {
    if ("jitterBufferTarget" in e.receiver) e.receiver.jitterBufferTarget = 0; // lowest latency
    else if ("playoutDelayHint" in e.receiver) e.receiver.playoutDelayHint = 0;
    const v = $("#video");
    if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
    $("#waiting").classList.add("hidden"); $("#unmute").classList.remove("hidden");
  };
  pc.ondatachannel = e => {
    const ch = e.channel;
    if (ch.label === "input") { inputCh = ch; inputCh.binaryType = "arraybuffer"; }
    if (ch.label === "tags") ch.onmessage = ev => {
      let t; try { t = JSON.parse(ev.data); } catch { return; }
      view.pushTags(t.map(x => [x[0], x[1] / 1e4, x[2] / 1e4, x[3]]));
    };
    if (ch.label === "ctrl") {
      ctrlCh = ch;
      ch.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === "welcome" || m.t === "layout") setLayout(m.layout || "full");
        if (m.names) view.setNames(m.names);
        if (m.t === "pong") {
          const ms = Math.round(performance.now() - m.ts);
          $("#rtt").textContent = $("#rtt2").textContent = `${ms} ms`; $("#rtt").classList.remove("hidden");
          ch.send(JSON.stringify({ t: "rtt", ms }));
        }
      };
    }
  };
  pc.onconnectionstatechange = () => {
    status(`Koneksi: ${pc.connectionState}`);
    if (pc.connectionState === "failed") fail("Koneksi P2P gagal. Coba jaringan lain atau minta host memasang TURN server.");
  };
  signal.send({ type: "join", room, name });
}

$("#unmute").onclick = () => {
  document.body.classList.add("playing");
  if (document.body.classList.contains("is-touch")) {
    const el = document.documentElement;
    const fs = el.requestFullscreen ? el.requestFullscreen({ navigationUI: "hide" }) : (el.webkitRequestFullscreen && el.webkitRequestFullscreen());
    Promise.resolve(fs).then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock("landscape")).catch(() => {});
  }
  const v = $("#video"); v.muted = false; v.play().catch(() => {});
  $("#overlay").classList.add("hidden");
  active = true;
};
$("#fsBtn").onclick = () => { const s = document.querySelector(".screen"); (s.requestFullscreen || s.webkitRequestFullscreen).call(s); };
// Name-tag data arrives before the video frames it belongs to (the video also waits in the
// encoder, jitter buffer and decoder), so tags are replayed with the measured video delay.
setInterval(async () => {
  if (!pc) return;
  try {
    (await pc.getStats()).forEach(r => {
      if (r.type !== "inbound-rtp" || r.kind !== "video" || !r.jitterBufferEmittedCount) return;
      const jb = r.jitterBufferDelay / r.jitterBufferEmittedCount, dec = r.framesDecoded ? r.totalDecodeTime / r.framesDecoded : 0;
      view.tagDelay = Math.min(400, Math.max(0, (jb + dec) * 1000 + 35));
    });
  } catch {}
}, 2000);
setInterval(() => { if (ctrlCh && ctrlCh.readyState === "open") ctrlCh.send(JSON.stringify({ t: "ping", ts: performance.now() })); }, 1000);

// ---------- Input capture ----------
const keysDown = new Set(), touchDown = new Set();
const isTyping = e => e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
addEventListener("keydown", e => {
  if (!active || isTyping(e)) return;
  const k = e.key.toLowerCase();
  if (k in KEYMAP || k in KEY_AXES) { keysDown.add(k); e.preventDefault(); }
});
addEventListener("keyup", e => { keysDown.delete(e.key.toLowerCase()); });
addEventListener("blur", () => keysDown.clear());

// Touch buttons: each keeps its own pointer, so several can be held at once.
for (const b of document.querySelectorAll("#touch button")) {
  const id = Number(b.dataset.b);
  let downAt = 0;
  const on = e => { e.preventDefault(); b.setPointerCapture && b.setPointerCapture(e.pointerId); downAt = performance.now(); touchDown.add(id); b.classList.add("on"); if (navigator.vibrate) navigator.vibrate(8); };
  // a quick tap must still reach the game: keep it held for at least ~4 frames
  const off = e => { e.preventDefault(); const wait = Math.max(0, 70 - (performance.now() - downAt)); setTimeout(() => { touchDown.delete(id); b.classList.remove("on"); }, wait); };
  b.addEventListener("pointerdown", on); b.addEventListener("pointerup", off);
  b.addEventListener("pointercancel", off); b.addEventListener("lostpointercapture", off);
  b.addEventListener("contextmenu", e => e.preventDefault());
}
// D-pad is one zone: slide the thumb to change direction (diagonals included).
const dpad = $("#dpad"), DIRS = { u: BTN.UP, d: BTN.DOWN, l: BTN.LEFT, r: BTN.RIGHT };
let dpadPointer = null;
function dpadSet(e) {
  for (const k in DIRS) touchDown.delete(DIRS[k]);
  dpad.querySelectorAll("span").forEach(s => s.classList.remove("on"));
  if (!e) return;
  const r = dpad.getBoundingClientRect(), x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
  if (Math.hypot(x, y) < r.width * 0.12) return; // dead zone in the middle
  const a = Math.atan2(y, x) * 180 / Math.PI; // 0 = right, 90 = down
  const dirs = [];
  if (a > -67.5 && a < 67.5) dirs.push("r");
  if (a > 112.5 || a < -112.5) dirs.push("l");
  if (a > 22.5 && a < 157.5) dirs.push("d");
  if (a < -22.5 && a > -157.5) dirs.push("u");
  for (const k of dirs) { touchDown.add(DIRS[k]); dpad.querySelector("." + k).classList.add("on"); }
}
dpad.addEventListener("pointerdown", e => { e.preventDefault(); dpadPointer = e.pointerId; dpad.setPointerCapture(e.pointerId); dpadSet(e); });
dpad.addEventListener("pointermove", e => { if (e.pointerId === dpadPointer) dpadSet(e); });
const dpadEnd = e => { if (e.pointerId === dpadPointer) { dpadPointer = null; dpadSet(null); } };
dpad.addEventListener("pointerup", dpadEnd); dpad.addEventListener("pointercancel", dpadEnd); dpad.addEventListener("lostpointercapture", dpadEnd);

const DEADZONE = 0.15;
function readState() {
  let buttons = 0; const axes = [0, 0, 0, 0];
  for (const k of keysDown) {
    if (k in KEYMAP) buttons |= 1 << KEYMAP[k];
    if (k in KEY_AXES) { const [a, dir] = KEY_AXES[k]; axes[a] = dir * 32767; }
  }
  for (const id of touchDown) buttons |= 1 << id;
  let padName = "";
  for (const gp of (navigator.getGamepads ? navigator.getGamepads() : [])) {
    if (!gp || !gp.connected) continue;
    padName = gp.id;
    gp.buttons.forEach((btn, i) => { if (i < PAD_BUTTONS.length && (btn.pressed || btn.value > 0.5)) buttons |= 1 << PAD_BUTTONS[i]; });
    for (let a = 0; a < 4 && a < gp.axes.length; a++) {
      const v = gp.axes[a];
      if (Math.abs(v) > DEADZONE && axes[a] === 0) axes[a] = Math.round(v * 32767);
    }
    break; // first connected gamepad drives this player
  }
  return { buttons, axes, padName };
}

let seq = 0, last = "", lastSent = 0, lastPad = null;
function tick(now) {
  if (active && inputCh && inputCh.readyState === "open") {
    const { buttons, axes, padName } = readState();
    const key = buttons + "," + axes.join(",");
    // send on change, and re-send every 100 ms since the channel is unreliable (lost packets self-heal)
    if (key !== last || now - lastSent > 100) {
      seq = (seq + 1) & 0xffff;
      inputCh.send(InputPacket.encode(seq, buttons, axes));
      last = key; lastSent = now;
    }
    if (padName !== lastPad) { $("#padStatus").textContent = padName ? `Gamepad: ${padName}` : "Gamepad: tidak ada (pakai keyboard)"; lastPad = padName; }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
