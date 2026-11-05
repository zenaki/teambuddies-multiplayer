"use strict";
// On-screen PlayStation pad for phones/tablets, shared by the host and guest pages.
// TouchPad.down is the set of libretro button ids currently held.
const TouchPad = { down: new Set() };
(() => {
  const isTouch = "ontouchstart" in window || matchMedia("(pointer: coarse)").matches;
  if (isTouch) document.body.classList.add("is-touch");
  if (!document.getElementById("touch")) { // host page: add the markup
    const host = document.querySelector(".stage") ? document.querySelector(".stage").parentElement : document.body;
    host.insertAdjacentHTML("beforeend", `<div class="touch" id="touch">
      <div class="shoulder left"><button data-b="12">L2</button><button data-b="10">L1</button></div>
      <div class="shoulder right"><button data-b="11">R1</button><button data-b="13">R2</button></div>
      <div class="pad" id="dpad"><span class="u">▲</span><span class="d">▼</span><span class="l">◀</span><span class="r">▶</span></div>
      <div class="mid"><button data-b="2">SELECT</button><button data-b="3">START</button></div>
      <div class="face"><button class="tri" data-b="9">△</button><button class="cir" data-b="8">○</button><button class="crs" data-b="0">✕</button><button class="sq" data-b="1">□</button></div>
    </div>`);
  }
  const touchDown = TouchPad.down;
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
  document.addEventListener("touchmove", e => { if (document.body.classList.contains("playing")) e.preventDefault(); }, { passive: false });
})();
// Fullscreen + landscape lock where the browser allows it (Android; iPhone needs "Add to Home Screen").
function enterPlayMode() {
  document.body.classList.add("playing");
  if (!document.body.classList.contains("is-touch")) return;
  const el = document.documentElement;
  try {
    const fs = el.requestFullscreen ? el.requestFullscreen({ navigationUI: "hide" }) : (el.webkitRequestFullscreen && el.webkitRequestFullscreen());
    Promise.resolve(fs).then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock("landscape")).catch(() => {});
  } catch {}
}
