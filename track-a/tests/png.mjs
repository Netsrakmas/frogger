/**
 * Minimal PNG reader for exactly what Playwright emits: 8-bit, non-interlaced,
 * colour type 2 (RGB) or 6 (RGBA).
 *
 * This exists because reading a WebGL canvas from inside the page gives an
 * empty buffer - the drawing buffer is not preserved between frames, so
 * drawImage() into a 2D canvas returns black. A screenshot taken by the browser
 * compositor is the only honest way to ask what colour the game actually is.
 */

import { inflateSync } from 'node:zlib';

export function decodePng(buffer) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) throw new Error('not a PNG');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (depth ${bitDepth}, colour ${colorType})`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * height);

  // Un-filter, row by row. Each row is prefixed with its filter type.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = value & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

/** Mean [r, g, b] across the whole image, 0-255. */
export function averageRgb(buffer) {
  const { width, height, channels, data } = decodePng(buffer);
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = width * height;
  for (let i = 0; i < pixels; i++) {
    r += data[i * channels];
    g += data[i * channels + 1];
    b += data[i * channels + 2];
  }
  return [r / pixels, g / pixels, b / pixels];
}
