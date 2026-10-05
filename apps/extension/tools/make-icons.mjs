// 生成扩展图标（无第三方依赖，只用 node:zlib 手写 PNG）
// 运行：node tools/make-icons.mjs
// 产物：icons/icon16.png icon32.png icon48.png icon128.png
//
// 图形：靛蓝圆角方块 + 白色放大镜（"捕手" 意象）
// 用 3x 超采样做抗锯齿
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '..', 'icons')
fs.mkdirSync(outDir, { recursive: true })

// ------------------------------------------------------------ PNG 编码
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // color type: RGBA
  ihdr[10] = 0  // deflate
  ihdr[11] = 0  // filter
  ihdr[12] = 0  // no interlace

  // 每行前加一个 filter 字节（0 = None）
  const raw = Buffer.alloc(height * (width * 4 + 1))
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      raw[p++] = rgba[i]
      raw[p++] = rgba[i + 1]
      raw[p++] = rgba[i + 2]
      raw[p++] = rgba[i + 3]
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ------------------------------------------------------------ 图形
const BG = [67, 56, 202]     // indigo-700 #4338CA
const FG = [255, 255, 255]   // 白色

/** 圆角矩形：点 (x,y) 是否在半径 r 的圆角矩形内（坐标归一化 0..1） */
function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r)
  const cy = Math.min(Math.max(y, r), 1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/** 线段距离（用于放大镜手柄） */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2))
  const dx = px - (ax + t * vx)
  const dy = py - (ay + t * vy)
  return Math.sqrt(dx * dx + dy * dy)
}

/** 白像素判定：放大镜（圆环 + 手柄） */
function inGlass(x, y) {
  const cx = 0.435
  const cy = 0.435
  const rOuter = 0.255
  const rInner = 0.165
  const d = Math.hypot(x - cx, y - cy)
  if (d <= rOuter && d >= rInner) return true
  // 手柄：从圆环右下方 45° 向外
  const a = Math.SQRT1_2
  const ax = cx + a * rOuter * 0.92
  const ay = cy + a * rOuter * 0.92
  const bx = 0.80
  const by = 0.80
  return distToSegment(x, y, ax, ay, bx, by) <= 0.062
}

function render(size) {
  const SS = 3 // 超采样倍率
  const rgba = Buffer.alloc(size * size * 4)
  const SAMPLES = SS * SS
  const RADIUS = 0.22

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHit = 0
      let fgHit = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size
          const v = (y + (sy + 0.5) / SS) / size
          if (inRoundRect(u, v, RADIUS)) {
            bgHit++
            if (inGlass(u, v)) fgHit++
          }
        }
      }
      const i = (y * size + x) * 4
      if (bgHit === 0) {
        rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0
        continue
      }
      const bgCov = bgHit / SAMPLES
      const fgCov = fgHit / SAMPLES
      // 先铺背景色，再按覆盖率混入白色
      const t = Math.min(1, fgCov / bgCov)
      rgba[i] = Math.round(BG[0] * (1 - t) + FG[0] * t)
      rgba[i + 1] = Math.round(BG[1] * (1 - t) + FG[1] * t)
      rgba[i + 2] = Math.round(BG[2] * (1 - t) + FG[2] * t)
      rgba[i + 3] = Math.round(bgCov * 255)
    }
  }
  return encodePng(size, size, rgba)
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`)
  fs.writeFileSync(file, render(size))
  console.log(`icons/icon${size}.png  ${fs.statSync(file).size} bytes`)
}
console.log('图标生成完成')
