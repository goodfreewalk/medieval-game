// Минимальный PNG-кодек без зависимостей (node:zlib).
// decode: 8-bit, без interlace, color types 0/2/3/4/6 → RGBA.
// encode: RGBA 8-bit, filter 0.

import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.slice(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG");
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    pos += 12 + len;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (depth !== 8 || interlace !== 0) {
    throw new Error(`unsupported PNG: depth=${depth} interlace=${interlace}`);
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels) {
    throw new Error(`unsupported PNG color type ${color}`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const lines = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;

    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? lines[dst + x - channels] : 0;
      const b = y > 0 ? lines[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? lines[dst - stride + x - channels] : 0;

      let r;
      if (filter === 0) r = v;
      else if (filter === 1) r = v + a;
      else if (filter === 2) r = v + b;
      else if (filter === 3) r = v + ((a + b) >> 1);
      else if (filter === 4) r = v + paeth(a, b, c);
      else throw new Error(`bad filter ${filter}`);

      lines[dst + x] = r & 0xff;
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    let r, g, b, a;

    if (color === 6) {
      r = lines[s]; g = lines[s + 1]; b = lines[s + 2]; a = lines[s + 3];
    } else if (color === 2) {
      r = lines[s]; g = lines[s + 1]; b = lines[s + 2]; a = 255;
    } else if (color === 0) {
      r = g = b = lines[s]; a = 255;
    } else if (color === 4) {
      r = g = b = lines[s]; a = lines[s + 1];
    } else {
      const idx = lines[s];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      a = trns && idx < trns.length ? trns[idx] : 255;
    }

    rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = b; rgba[d + 3] = a;
  }

  return { width, height, data: rgba };
}

export function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
