// Generates the PWA icons as plain PNGs without external tools.
// Design: dark background, red "lens" ring with a dot in the middle.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const BG = [28, 28, 30]
// The app accent, --accent in main.css.
const FG = [255, 59, 48]

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function icon(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size)
  const c = size / 2
  const ringOuter = size * 0.3
  const ringInner = size * 0.22
  const dot = size * 0.09
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0
    for (let x = 0; x < size; x++) {
      // 4x supersampling for smooth edges
      let cover = 0
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const d = Math.hypot(x + (sx + 0.5) / 2 - c, y + (sy + 0.5) / 2 - c)
          if ((d <= ringOuter && d >= ringInner) || d <= dot) cover++
        }
      const a = cover / 4
      const off = y * (size * 3 + 1) + 1 + x * 3
      for (let i = 0; i < 3; i++) raw[off + i] = Math.round(BG[i] * (1 - a) + FG[i] * a)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const dir = new URL('../public/icons/', import.meta.url)
mkdirSync(dir, { recursive: true })
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
  ['favicon.png', 32],
]) {
  writeFileSync(new URL(name, dir), icon(size))
}
console.log('icons written')
