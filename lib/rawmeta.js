// 讀取 RAW（TIFF 架構：ARW / NEF / DNG / PEF / CR2 / ORF / RW2 …）的拍攝資訊與內嵌 JPEG 預覽圖
// 不需要外部程式，直接解析 TIFF IFD。
const fs = require('fs');

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

function readHead(file, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(len, size);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    return { buf, size };
  } finally { fs.closeSync(fd); }
}

function readRange(file, off, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, off);
    return buf;
  } finally { fs.closeSync(fd); }
}

class Tiff {
  constructor(buf, base = 0) {
    this.b = buf; this.base = base;
    const bo = buf.toString('latin1', base, base + 2);
    this.le = bo === 'II';
    if (!this.le && bo !== 'MM') throw new Error('not tiff');
  }
  u16(o) { return this.le ? this.b.readUInt16LE(o) : this.b.readUInt16BE(o); }
  u32(o) { return this.le ? this.b.readUInt32LE(o) : this.b.readUInt32BE(o); }
  i32(o) { return this.le ? this.b.readInt32LE(o) : this.b.readInt32BE(o); }
  ifd(off) {
    const abs = this.base + off;
    if (abs + 2 > this.b.length || off === 0) return null;
    const n = this.u16(abs);
    if (n > 1000) return null;
    const tags = {};
    for (let i = 0; i < n; i++) {
      const e = abs + 2 + i * 12;
      if (e + 12 > this.b.length) break;
      const tag = this.u16(e), type = this.u16(e + 2), count = this.u32(e + 4);
      const sz = (TYPE_SIZE[type] || 1) * count;
      const voff = sz <= 4 ? e + 8 : this.base + this.u32(e + 8);
      tags[tag] = { type, count, voff };
    }
    const nextPos = abs + 2 + n * 12;
    const next = nextPos + 4 <= this.b.length ? this.u32(nextPos) : 0;
    return { tags, next };
  }
  val(t, i = 0) {
    if (!t) return undefined;
    const o = t.voff;
    if (o >= this.b.length) return undefined;
    switch (t.type) {
      case 3: return this.u16(o + i * 2);
      case 4: case 13: return this.u32(o + i * 4);
      case 9: return this.i32(o + i * 4);
      case 5: { const a = this.u32(o + i * 8), b = this.u32(o + i * 8 + 4); return b ? a / b : 0; }
      case 10: { const a = this.i32(o + i * 8), b = this.i32(o + i * 8 + 4); return b ? a / b : 0; }
      case 1: case 7: return this.b[o + i];
      default: return this.b[o + i];
    }
  }
  vals(t) { const r = []; if (!t) return r; for (let i = 0; i < t.count; i++) r.push(this.val(t, i)); return r; }
  str(t) {
    if (!t) return '';
    const end = Math.min(t.voff + t.count, this.b.length);
    return this.b.toString('latin1', t.voff, end).replace(/\0.*$/s, '').trim();
  }
}

function parse(file) {
  // 大部分 RAW 的 IFD 都在前 1MB 內（必要時讀更多）
  const { buf, size } = readHead(file, 4 * 1024 * 1024);
  return parseTiff(buf, 0, size);
}
function parseTiff(buf, base, size) {
  const t = new Tiff(buf, base);
  const info = { make: '', model: '', lens: '', iso: 0, fnum: 0, exposure: 0, focal: 0, date: '', orientation: 1, width: 0, height: 0 };
  const jpegs = [];
  const seen = new Set();

  const walk = (off, depth) => {
    if (!off || depth > 4 || seen.has(off)) return;
    seen.add(off);
    const d = t.ifd(off);
    if (!d) return;
    const g = d.tags;
    if (g[0x10f] && !info.make) info.make = t.str(g[0x10f]);
    if (g[0x110] && !info.model) info.model = t.str(g[0x110]);
    if (g[0x112] && depth === 0) info.orientation = t.val(g[0x112]) || 1;
    if (g[0x132] && !info.date) info.date = t.str(g[0x132]);
    // 內嵌 JPEG（JPEGInterchangeFormat）
    if (g[0x201] && g[0x202]) jpegs.push({ off: t.val(g[0x201]), len: t.val(g[0x202]) });
    // 以 strip 方式存放的 JPEG（DNG / NEF 的預覽）
    const comp = g[0x103] ? t.val(g[0x103]) : 0;
    if ((comp === 6 || comp === 7) && g[0x111] && g[0x117]) {
      const bps = g[0x102] ? t.val(g[0x102]) : 8;
      const photo = g[0x106] ? t.val(g[0x106]) : 6;
      if (bps === 8 && (photo === 6 || photo === 2) && g[0x111].count === 1) {
        jpegs.push({ off: t.val(g[0x111]), len: t.val(g[0x117]), w: t.val(g[0x100]), h: t.val(g[0x101]) });
      }
    }
    if ((g[0xfe] ? t.val(g[0xfe]) : 0) === 0 && g[0x100] && g[0x101]) {
      const w = t.val(g[0x100]), h = t.val(g[0x101]);
      if (w * h > info.width * info.height && w > 1000) { info.width = w; info.height = h; }
    }
    // Exif IFD
    if (g[0x8769]) {
      const e = t.ifd(t.val(g[0x8769]));
      if (e) {
        const x = e.tags;
        if (x[0x829a]) info.exposure = t.val(x[0x829a]);
        if (x[0x829d]) info.fnum = t.val(x[0x829d]);
        if (x[0x8827]) info.iso = t.val(x[0x8827]);
        if (x[0x9003]) info.date = t.str(x[0x9003]) || info.date;
        if (x[0x920a]) info.focal = t.val(x[0x920a]);
        if (x[0xa434]) info.lens = t.str(x[0xa434]);
        if (!info.lens && x[0xa432] && x[0xa432].count === 4) { const [f1, f2, a1, a2] = t.vals(x[0xa432]); if (f1) info.lens = (f1 === f2 ? `${Math.round(f1)}mm` : `${Math.round(f1)}-${Math.round(f2)}mm`) + (a1 ? ` f/${+a1.toFixed(1)}${a2 && a2 !== a1 ? '-' + +a2.toFixed(1) : ''}` : ''); }
        if (!info.lens && x[0xa433] && x[0xa434] === undefined) info.lens = '';
        if (x[0xa002] && x[0xa003]) {
          const w = t.val(x[0xa002]), h = t.val(x[0xa003]);
          if (w * h > info.width * info.height) { info.width = w; info.height = h; }
        }
      }
    }
    if (g[0x14a]) for (const s of t.vals(g[0x14a])) walk(s, depth + 1);
    if (d.next) walk(d.next, depth);
  };
  walk(t.u32(base + 4), 0);
  if (!info.lens && info.focal) info.lens = '';
  return { info, jpegs, size };
}

function isJpeg(file, off, size) {
  if (!off || off + 4 > size) return false;
  const b = readRange(file, off, 3);
  return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

// 由 JPEG 檔頭讀取尺寸
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function extractPreview(file) {
  const { jpegs, size } = parse(file);
  const ok = jpegs.filter(j => j.len > 1000 && j.off + j.len <= size && isJpeg(file, j.off, size));
  ok.sort((a, b) => b.len - a.len);
  if (!ok.length) return null;
  const buf = readRange(file, ok[0].off, ok[0].len);
  return { buf, dims: jpegSize(buf) };
}

function readInfo(file) {
  try { return parse(file).info; } catch { return null; }
}

// 一般照片（JPEG / TIFF / PNG / WebP）的拍攝資訊：JPEG 的 EXIF 在 APP1 區段裡，本身就是一份 TIFF
function readImageInfo(file) {
  const empty = { make: '', model: '', lens: '', iso: 0, fnum: 0, exposure: 0, focal: 0, date: '', orientation: 1, width: 0, height: 0 };
  try {
    const { buf, size } = readHead(file, 512 * 1024);
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let info = { ...empty }; let i = 2;
      while (i + 4 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1]; if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        if (m === 0xda || m === 0xd9) break;
        const len = buf.readUInt16BE(i + 2);
        if (m === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') { try { info = { ...info, ...parseTiff(buf, i + 10, size).info }; } catch {} }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7); if (w && h) { info.width = w; info.height = h; } }
        i += 2 + len;
      }
      if (info.orientation >= 5 && info.orientation <= 8 && info.width) { const w = info.width; info.width = info.height; info.height = w; }
      return info;
    }
    const bo = buf.toString('latin1', 0, 2); if (bo === 'II' || bo === 'MM') return parseTiff(buf, 0, size).info;
    if (buf.toString('latin1', 1, 4) === 'PNG') return { ...empty, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const k = buf.toString('latin1', 12, 16);
      if (k === 'VP8X') return { ...empty, width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (k === 'VP8 ') return { ...empty, width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (k === 'VP8L') { const b = buf.readUInt32LE(21); return { ...empty, width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    }
    return empty;
  } catch { return null; }
}

module.exports = { readInfo, readImageInfo, extractPreview, jpegSize };
