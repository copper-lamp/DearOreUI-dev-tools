import { mkdirSync, writeFileSync } from "node:fs";

const OUT_DIR = process.argv[2];
const S = 32; // classic 32x32 icon

// 32bpp bottom-up DIB: 40-byte BITMAPINFOHEADER + XOR (BGRA) + AND mask (1bpp)
const header = Buffer.alloc(40);
header.writeUInt32LE(40, 0); // biSize
header.writeInt32LE(S, 4); // biWidth
header.writeInt32LE(S * 2, 8); // biHeight (XOR + AND)
header.writeUInt16LE(1, 12); // biPlanes
header.writeUInt16LE(32, 14); // biBitCount
header.writeUInt32LE(0, 16); // biCompression = BI_RGB

const xorHeight = S * S * 4; // 32bpp
const andRowBytes = 4; // ceil(32/8), aligned to 4 for 32-bit scanline
const andHeight = S * andRowBytes; // 128
header.writeUInt32LE(xorHeight + andHeight, 20); // biSizeImage

// XOR pixels: BGRA, dark blue with a simple rounded 'D'
const xor = Buffer.alloc(xorHeight);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const idx = (y * S + x) * 4;
    const edge = x === 0 || y === 0 || x === S - 1 || y === S - 1;
    const diag = x === y || x === S - 1 - y;
    const lit = edge || (x >= 8 && x <= 22 && y >= 8 && y <= 22);
    // BGRA
    xor[idx] = edge ? 0x6b : 0x9f; // blue
    xor[idx + 1] = edge ? 0x6e : 0x4c;
    xor[idx + 2] = edge ? 0x5c : 0x2e;
    xor[idx + 3] = 0xff;
  }
}
// AND mask: transparent mask (all 0 => opaque). Keep fully opaque.
const and = Buffer.alloc(andHeight);

// Assemble ICO
const icondir = Buffer.alloc(6);
icondir.writeUInt16LE(1, 2); // type: icon
icondir.writeUInt16LE(1, 4); // count

const bmp = Buffer.concat([header, xor, and]);
const entry = Buffer.alloc(16);
entry[0] = S; // width
entry[1] = S; // height
entry[2] = 0; // colors 0
entry[3] = 0;
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bitcount
entry.writeUInt32LE(bmp.length, 8); // bytesInRes
entry.writeUInt32LE(6 + 16, 12); // offset

const ico = Buffer.concat([icondir, entry, bmp]);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/icon.ico`, ico);
console.log(`wrote icon.ico (${ico.length} bytes) -> ${OUT_DIR}`);