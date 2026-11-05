"use strict";
// Guest: receives the host's game stream and sends this player's pad state.

const params = new URLSearchParams(location.search);
$("#room").value = (params.get("room") || "").toUpperCase();
$("#name").value = params.get("name") || localStorageGet("tb-name") || "";
if ("ontouchstart" in window) document.body.classList.add("is-touch");

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

let pc, inputCh, ctrlCh, signal, mySlot = 0, active = false;
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
    mySlot = slot;
    $("#you").textContent = `Kamu P${slot}`; $("#you").classList.remove("hidden");
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
    if (ch.label === "ctrl") {
      ctrlCh = ch;
      ch.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === "pong") {
          const ms = Math.round(performance.now() - m.ts);
          $("#rtt").textContent = `${ms} ms`; $("#rtt").classList.remove("hidden");
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
  const v = $("#video"); v.muted = false; v.play().catch(() => {});
  $("#overlay").classList.add("hidden");
  active = true;
};
$("#fsBtn").onclick = () => { const s = document.querySelector(".screen"); (s.requestFullscreen || s.webkitRequestFullscreen).call(s); };
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

for (const b of document.querySelectorAll("#touch button")) {
  const id = Number(b.dataset.b);
  const on = e => { e.preventDefault(); touchDown.add(id); b.classList.add("on"); };
  const off = e => { e.preventDefault(); touchDown.delete(id); b.classList.remove("on"); };
  b.addEventListener("pointerdown", on); b.addEventListener("pointerup", off);
  b.addEventListener("pointercancel", off); b.addEventListener("pointerleave", off);
}

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
