// Generates public/icons/icon-192.png, icon-512.png, maskable-512.png and icon.svg: a gold hexagon with a star.
// Pure Node (zlib) PNG encoder so the build needs no native image dependency.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "../public/icons");
mkdirSync(out, { recursive: true });

const BG = [11, 15, 20];
const GOLD = [212, 167, 58];
const GOLD2 = [242, 210, 122];

function polygon(cx, cy, r, n, rot = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i * 2 * Math.PI) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}
function star(cx, cy, r1, r2) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? r2 : r1;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}
function inside(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function render(size, { maskable }) {
  const c = size / 2;
  const hexR = size * (maskable ? 0.34 : 0.44);
  const hexOuter = polygon(c, c, hexR, 6, -Math.PI / 2);
  const hexInner = polygon(c, c, hexR * 0.86, 6, -Math.PI / 2);
  const st = star(c, c + size * 0.01, hexR * 0.52, hexR * 0.22);
  // 2x2 supersampling for soft edges
  return png(size, (x, y) => {
    let r = 0, g = 0, b = 0, a = 0;
    for (const dx of [-0.25, 0.25]) for (const dy of [-0.25, 0.25]) {
      const px = x + dx, py = y + dy;
      let col, alpha = 1;
      if (inside(st, px, py)) col = GOLD2;
      else if (inside(hexInner, px, py)) col = [20, 27, 36];
      else if (inside(hexOuter, px, py)) col = GOLD;
      else { col = BG; alpha = maskable ? 1 : 1; }
      r += col[0]; g += col[1]; b += col[2]; a += alpha;
    }
    return [r / 4, g / 4, b / 4, (a / 4) * 255];
  });
}

writeFileSync(join(out, "icon-192.png"), render(192, { maskable: false }));
writeFileSync(join(out, "icon-512.png"), render(512, { maskable: false }));
writeFileSync(join(out, "maskable-512.png"), render(512, { maskable: true }));
writeFileSync(
  join(out, "icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0b0f14"/><polygon points="32,4 56,18 56,46 32,60 8,46 8,18" fill="#d4a73a"/><polygon points="32,8 52,20 52,44 32,56 12,44 12,20" fill="#141b24"/><polygon points="32,18 36.5,28.5 48,29.5 39.5,37 42,48.5 32,42.5 22,48.5 24.5,37 16,29.5 27.5,28.5" fill="#f2d27a"/></svg>\n`,
);
console.log("icons written to", out);
