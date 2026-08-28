'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const outputDir = path.join(__dirname, '..', 'public', 'icons');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function makeIcon(size) {
  const rowBytes = size * 4 + 1;
  const raw = Buffer.alloc(rowBytes * size);
  const paper = [242, 239, 232, 255];
  const ink = [31, 43, 48, 255];
  const rust = [157, 72, 49, 255];
  const margin = Math.floor(size * 0.14);
  const stroke = Math.max(5, Math.floor(size * 0.075));
  const split = Math.floor(size * 0.6);
  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0;
    for (let x = 0; x < size; x++) {
      let color = paper;
      const aLeft = x >= margin && x < margin + stroke && y >= split - x / 2 && y <= size - margin;
      const aRight = x >= split - stroke && x < split && y >= margin + x / 2 && y <= size - margin;
      const aBar = y >= split && y < split + stroke && x >= margin + stroke && x < split - stroke;
      const iStem = x >= Math.floor(size * 0.7) && x < Math.floor(size * 0.7) + stroke && y >= margin + stroke * 2 && y < size - margin;
      const iDot = x >= Math.floor(size * 0.7) && x < Math.floor(size * 0.7) + stroke && y >= margin && y < margin + stroke;
      if (aLeft || aRight || aBar || iStem) color = ink;
      if (iDot) color = rust;
      const at = y * rowBytes + 1 + x * 4;
      raw.set(color, at);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(outputDir, { recursive: true });
for (const size of [192, 512]) fs.writeFileSync(path.join(outputDir, `icon-${size}.png`), makeIcon(size));

