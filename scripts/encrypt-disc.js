// Encrypts a disc image into AES-256-GCM parts that the host page can download and decrypt
// in the browser after login. The key comes from PBKDF2-SHA256(username + "\n" + password).
//   node scripts/encrypt-disc.js "<disc file>" <out dir> <username> <password>
// Nothing secret is written: without the username/password the parts are unreadable.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [src, out, user, pass] = process.argv.slice(2);
if (!src || !out || !user || !pass) { console.error("usage: encrypt-disc.js <disc> <outdir> <username> <password>"); process.exit(1); }
const ITER = 600000, CHUNK = 24 << 20;
const salt = crypto.randomBytes(16);
const key = crypto.pbkdf2Sync(`${user}\n${pass}`, salt, ITER, 32, "sha256");
const seal = buf => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  return { iv, data: Buffer.concat([c.update(buf), c.final(), c.getAuthTag()]) };
};
fs.mkdirSync(out, { recursive: true });
const size = fs.statSync(src).size, fd = fs.openSync(src, "r"), parts = [];
for (let off = 0, i = 0; off < size; off += CHUNK, i++) {
  const n = Math.min(CHUNK, size - off), buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, off);
  const { iv, data } = seal(buf), file = `part-${String(i).padStart(3, "0")}.bin`;
  fs.writeFileSync(path.join(out, file), data);
  parts.push({ file, iv: iv.toString("base64"), size: n });
}
const check = seal(Buffer.from("team-buddies-ok"));
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({
  name: path.basename(src), size, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITER, salt: salt.toString("base64") },
  check: { iv: check.iv.toString("base64"), data: check.data.toString("base64") }, parts,
}, null, 1));
console.log(`${parts.length} parts, ${size} bytes -> ${out}`);
