import { canvasEncoder, fitSize, processFrame, type Encoder, type FrameSource } from './process'
import { computeDayKey } from '@/utils/date'
import type { DraftFilter, FilmFilterId, ProcessedPhoto } from '@/storage/types'

type Rgb = readonly [number, number, number]

export type PresetGroup = 'film' | 'camera'

/** Parameters of a film stock or a camera look. All colour values are in the 0..1 range. */
export interface FilmPreset {
  id: FilmFilterId
  name: string
  /** Short hint shown under the preview. */
  note: string
  group: PresetGroup | 'none'
  /** Black and white film: channels are mixed into one luminance. */
  mono: boolean
  /** 1 keeps saturation, 0 removes colour. */
  saturation: number
  /** Positive values warm the image (more red, less blue). */
  warmth: number
  /** Positive values add green, negative add magenta. */
  tint: number
  /** Contrast around mid grey; 1 keeps it. */
  contrast: number
  /** Colour added to shadows and highlights (split toning). */
  shadows: Rgb
  highlights: Rgb
  /** Output black and white points: faded blacks and soft highlights. */
  black: number
  white: number
  /** Strength of the luminance grain. */
  grain: number
  /** Darkening at the corners. */
  vignette: number
  /** Red glow around bright areas, as on film without an anti-halation layer. */
  halation: number
  /** Lens softness: 0 sharp, 1 very soft. Stronger towards the corners. */
  softness: number
  /** Orange light leak from the frame edge. */
  lightLeak: number
  /** Instant film: square crop with a white frame. */
  instantFrame: boolean
  /** Whether the date imprint is on by default (cameras with a date back). */
  dateStamp: boolean
}

const NONE: FilmPreset = {
  id: 'none',
  name: 'Оригинал',
  note: '',
  group: 'none',
  mono: false,
  saturation: 1,
  warmth: 0,
  tint: 0,
  contrast: 1,
  shadows: [0, 0, 0],
  highlights: [0, 0, 0],
  black: 0,
  white: 1,
  grain: 0,
  vignette: 0,
  halation: 0,
  softness: 0,
  lightLeak: 0,
  instantFrame: false,
  dateStamp: false,
}

export const FILM_PRESETS: readonly FilmPreset[] = [
  NONE,
  // --- film stocks ------------------------------------------------------
  {
    ...NONE,
    id: 'portra',
    name: 'Portra 400',
    note: 'Kodak: тёплая кожа, мягкий контраст',
    group: 'film',
    saturation: 0.88,
    warmth: 0.35,
    tint: 0.05,
    contrast: 0.92,
    shadows: [0.02, 0.01, -0.01],
    highlights: [0.03, 0.01, -0.03],
    black: 0.05,
    white: 0.97,
    grain: 0.05,
    vignette: 0.2,
  },
  {
    ...NONE,
    id: 'gold',
    name: 'Gold 200',
    note: 'Kodak: жёлтое летнее солнце',
    group: 'film',
    saturation: 1.08,
    warmth: 0.55,
    tint: 0.12,
    contrast: 1.04,
    shadows: [0.02, 0.01, -0.02],
    highlights: [0.05, 0.03, -0.05],
    black: 0.04,
    white: 0.97,
    grain: 0.07,
    vignette: 0.2,
  },
  {
    ...NONE,
    id: 'superia',
    name: 'Superia 400',
    note: 'Fuji: сочная зелень, холодные тени',
    group: 'film',
    saturation: 1.12,
    warmth: -0.08,
    tint: 0.3,
    contrast: 1.1,
    shadows: [-0.03, 0.01, 0.04],
    highlights: [0.03, 0.02, -0.02],
    black: 0.04,
    white: 0.98,
    grain: 0.06,
    vignette: 0.25,
  },
  {
    ...NONE,
    id: 'cine',
    name: 'CineStill 800T',
    note: 'Киноплёнка: красный ореол у огней',
    group: 'film',
    saturation: 0.95,
    warmth: -0.25,
    contrast: 1.05,
    shadows: [-0.04, 0.01, 0.06],
    highlights: [0.07, 0.02, -0.03],
    black: 0.06,
    white: 0.96,
    grain: 0.06,
    vignette: 0.25,
    halation: 0.9,
  },
  {
    ...NONE,
    id: 'hp5',
    name: 'HP5 ч/б',
    note: 'Ilford: контрастное зерно',
    group: 'film',
    mono: true,
    saturation: 0,
    contrast: 1.25,
    black: 0.04,
    white: 0.98,
    grain: 0.1,
    vignette: 0.3,
  },
  {
    ...NONE,
    id: 'expired',
    name: 'Просрочка',
    note: 'Плёнка 90-х из ящика',
    group: 'film',
    saturation: 0.7,
    warmth: 0.4,
    tint: -0.2,
    contrast: 0.85,
    shadows: [0.05, 0, 0.04],
    highlights: [0.04, 0.03, -0.04],
    black: 0.14,
    white: 0.92,
    grain: 0.09,
    vignette: 0.4,
  },
  // --- cameras ----------------------------------------------------------
  {
    ...NONE,
    id: 'contax-t2',
    name: 'Contax T2',
    note: 'Резкий Zeiss, глубокий цвет, Portra',
    group: 'camera',
    saturation: 1.05,
    warmth: 0.3,
    tint: 0.04,
    contrast: 1.08,
    shadows: [0.01, 0.01, 0.01],
    highlights: [0.03, 0.015, -0.03],
    black: 0.03,
    white: 0.98,
    grain: 0.045,
    vignette: 0.15,
    halation: 0.15,
  },
  {
    ...NONE,
    id: 'mju-ii',
    name: 'Olympus μ-II',
    note: 'Мыльница со вспышкой, Superia, дата',
    group: 'camera',
    saturation: 1.15,
    warmth: 0.05,
    tint: 0.18,
    contrast: 1.18,
    shadows: [-0.02, 0.01, 0.04],
    highlights: [0.04, 0.03, 0],
    black: 0.03,
    white: 0.99,
    grain: 0.065,
    vignette: 0.35,
    softness: 0.15,
    dateStamp: true,
  },
  {
    ...NONE,
    id: 'leica-m6',
    name: 'Leica M6',
    note: 'Tri-X 400, мягкое свечение светов',
    group: 'camera',
    mono: true,
    saturation: 0,
    contrast: 1.35,
    shadows: [0.01, 0.01, 0.01],
    black: 0.02,
    white: 0.97,
    grain: 0.11,
    vignette: 0.22,
    halation: 0.25,
  },
  {
    ...NONE,
    id: 'lomo',
    name: 'Lomo LC-A',
    note: 'Тёмные углы, кислотный цвет',
    group: 'camera',
    saturation: 1.35,
    warmth: 0.1,
    tint: 0.1,
    contrast: 1.3,
    shadows: [-0.04, 0.02, 0.07],
    highlights: [0.06, 0.05, -0.05],
    black: 0.02,
    white: 0.99,
    grain: 0.07,
    vignette: 0.75,
    softness: 0.45,
  },
  {
    ...NONE,
    id: 'disposable',
    name: 'Одноразовая',
    note: 'Kodak FunSaver: засветка, пластиковая линза',
    group: 'camera',
    saturation: 1.05,
    warmth: 0.45,
    tint: 0.08,
    contrast: 1.12,
    shadows: [0.03, 0.01, -0.01],
    highlights: [0.05, 0.03, -0.04],
    black: 0.06,
    white: 0.96,
    grain: 0.09,
    vignette: 0.45,
    softness: 0.35,
    lightLeak: 0.55,
    dateStamp: true,
  },
  {
    ...NONE,
    id: 'polaroid',
    name: 'Polaroid SX-70',
    note: 'Квадрат в рамке, кремовые света',
    group: 'camera',
    saturation: 0.75,
    warmth: 0.25,
    tint: 0.12,
    contrast: 0.88,
    shadows: [0.02, 0.05, 0.06],
    highlights: [0.05, 0.04, -0.02],
    black: 0.1,
    white: 0.93,
    grain: 0.03,
    vignette: 0.3,
    softness: 0.3,
    instantFrame: true,
  },
]

export const DEFAULT_FILTER: DraftFilter = { id: 'none', strength: 1, date: false }

export function getPreset(id: FilmFilterId): FilmPreset {
  return FILM_PRESETS.find((p) => p.id === id) ?? NONE
}

/** True when the filter leaves the photo unchanged, so re-encoding can be skipped. */
export function isIdentity(filter: DraftFilter | undefined): boolean {
  return !filter || (filter.id === 'none' && !filter.date)
}

/** Small deterministic PRNG, so the same photo gets the same grain and light leak. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Seed for the random parts of a look, taken from the photo hash. */
export function seedFromHash(hash: string): number {
  return parseInt(hash.slice(0, 8), 16) || 1
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Long side of the buffer used for glow and softness. Fixed, so the preview matches the saved photo. */
const BLUR_GRID = 192

interface BlurMap {
  data: Float32Array
  width: number
  height: number
  channels: number
}

/** Area-averages the image onto a small grid; `pick` returns the channels kept per pixel. */
function downsample(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  pick: (r: number, g: number, b: number, out: Float32Array, o: number) => void,
): BlurMap {
  const size = fitSize(width, height, BLUR_GRID)
  const data = new Float32Array(size.width * size.height * channels)
  const counts = new Float32Array(size.width * size.height)
  const sx = size.width / width
  const sy = size.height / height
  const tmp = new Float32Array(channels)
  for (let y = 0, i = 0; y < height; y++) {
    const row = Math.min(size.height - 1, Math.floor(y * sy)) * size.width
    for (let x = 0; x < width; x++, i += 4) {
      const cell = row + Math.min(size.width - 1, Math.floor(x * sx))
      pick(src[i] / 255, src[i + 1] / 255, src[i + 2] / 255, tmp, 0)
      for (let c = 0; c < channels; c++) data[cell * channels + c] += tmp[c]
      counts[cell]++
    }
  }
  for (let cell = 0; cell < counts.length; cell++) {
    const n = counts[cell] || 1
    for (let c = 0; c < channels; c++) data[cell * channels + c] /= n
  }
  return { data, width: size.width, height: size.height, channels }
}

/** Three box-blur passes in both directions: a cheap approximation of a gaussian. */
function blur(map: BlurMap, radius: number): void {
  const { width, height, channels } = map
  const tmp = new Float32Array(map.data.length)
  const pass = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
    const len = horizontal ? width : height
    const lines = horizontal ? height : width
    const step = horizontal ? channels : width * channels
    for (let line = 0; line < lines; line++) {
      const base = horizontal ? line * width * channels : line * channels
      for (let c = 0; c < channels; c++) {
        for (let p = 0; p < len; p++) {
          let sum = 0
          let n = 0
          for (let k = Math.max(0, p - radius); k <= Math.min(len - 1, p + radius); k++) {
            sum += src[base + k * step + c]
            n++
          }
          dst[base + p * step + c] = sum / n
        }
      }
    }
  }
  for (let i = 0; i < 3; i++) {
    pass(map.data, tmp, true)
    pass(tmp, map.data, false)
  }
}

/** Bilinear lookup in the small map at normalised coordinates. */
function sample(map: BlurMap, u: number, v: number, out: Float32Array): void {
  const fx = Math.min(map.width - 1, Math.max(0, u * map.width - 0.5))
  const fy = Math.min(map.height - 1, Math.max(0, v * map.height - 0.5))
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(map.width - 1, x0 + 1)
  const y1 = Math.min(map.height - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0
  const ch = map.channels
  for (let c = 0; c < ch; c++) {
    const a = map.data[(y0 * map.width + x0) * ch + c]
    const b = map.data[(y0 * map.width + x1) * ch + c]
    const d = map.data[(y1 * map.width + x0) * ch + c]
    const e = map.data[(y1 * map.width + x1) * ch + c]
    out[c] = (a + (b - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty
  }
}

interface LightLeak {
  /** 0 left, 1 right, 2 top, 3 bottom. */
  edge: number
  /** Centre of the leak along the edge, 0..1. */
  center: number
  /** Depth into the frame, as a share of the frame. */
  depth: number
}

function pickLightLeak(rand: () => number): LightLeak {
  return { edge: Math.floor(rand() * 4), center: 0.2 + rand() * 0.6, depth: 0.25 + rand() * 0.25 }
}

function leakAmount(leak: LightLeak, u: number, v: number): number {
  const [across, along] =
    leak.edge === 0 ? [u, v] : leak.edge === 1 ? [1 - u, v] : leak.edge === 2 ? [v, u] : [1 - v, u]
  const spread = along - leak.center
  return Math.exp(-across / leak.depth) * Math.exp(-(spread * spread) / 0.08)
}

/**
 * Applies a film look in place to RGBA pixels.
 * `strength` blends between the original (0) and the full effect (1).
 * The result does not depend on the image resolution, except for grain size.
 */
export function applyFilm(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  preset: FilmPreset,
  strength = 1,
  seed = 1,
): void {
  const k = clamp01(strength)
  if (preset.id === 'none' || k === 0) return
  const rand = mulberry32(seed)
  const leak = preset.lightLeak > 0 ? pickLightLeak(rand) : null

  const soft =
    preset.softness > 0
      ? downsample(data, width, height, 3, (r, g, b, out) => {
          out[0] = r
          out[1] = g
          out[2] = b
        })
      : null
  if (soft) blur(soft, 2)
  const glow =
    preset.halation > 0
      ? downsample(data, width, height, 1, (r, g, b, out) => {
          out[0] = clamp01((0.299 * r + 0.587 * g + 0.114 * b - 0.75) / 0.25)
        })
      : null
  if (glow) blur(glow, 4)
  const px = new Float32Array(3)

  const cx = width / 2
  const cy = height / 2
  const maxDist = Math.hypot(cx, cy) || 1
  // Grain is defined for a ~2000 px photo; smaller previews get finer grain so it looks alike.
  const grainAmp = preset.grain * Math.min(1, Math.max(width, height) / 2048 + 0.35)
  const range = preset.white - preset.black
  const warm = preset.warmth * 0.08
  const tint = preset.tint * 0.04

  for (let y = 0, i = 0; y < height; y++) {
    const dy = (y - cy) / maxDist
    const v = (y + 0.5) / height
    for (let x = 0; x < width; x++, i += 4) {
      const r0 = data[i] / 255
      const g0 = data[i + 1] / 255
      const b0 = data[i + 2] / 255
      let r = r0
      let g = g0
      let b = b0
      const u = (x + 0.5) / width
      const dx = (x - cx) / maxDist
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (soft) {
        // Cheap lenses are soft everywhere and much softer in the corners.
        sample(soft, u, v, px)
        const m = preset.softness * (0.35 + 0.65 * dist * dist)
        r += (px[0] - r) * m
        g += (px[1] - g) * m
        b += (px[2] - b) * m
      }

      if (preset.mono) {
        // Panchromatic film is a bit more sensitive to red and green.
        r = g = b = 0.35 * r + 0.55 * g + 0.1 * b
      } else {
        const l = 0.299 * r + 0.587 * g + 0.114 * b
        r = l + (r - l) * preset.saturation + warm
        g = l + (g - l) * preset.saturation + tint
        b = l + (b - l) * preset.saturation - warm
      }

      r = (r - 0.5) * preset.contrast + 0.5
      g = (g - 0.5) * preset.contrast + 0.5
      b = (b - 0.5) * preset.contrast + 0.5

      const l = clamp01(0.299 * r + 0.587 * g + 0.114 * b)
      const sw = (1 - l) * (1 - l)
      const hw = l * l
      r += preset.shadows[0] * sw + preset.highlights[0] * hw
      g += preset.shadows[1] * sw + preset.highlights[1] * hw
      b += preset.shadows[2] * sw + preset.highlights[2] * hw

      if (glow) {
        sample(glow, u, v, px)
        const h = px[0] * preset.halation
        if (preset.mono) {
          r += h * 0.35
          g += h * 0.35
          b += h * 0.35
        } else {
          r += h * 0.9
          g += h * 0.25
          b += h * 0.05
        }
      }

      r = preset.black + clamp01(r) * range
      g = preset.black + clamp01(g) * range
      b = preset.black + clamp01(b) * range

      if (leak) {
        // Screen blend of an orange-red glow.
        const a = leakAmount(leak, u, v) * preset.lightLeak
        r = 1 - (1 - r) * (1 - a)
        g = 1 - (1 - g) * (1 - a * 0.45)
        b = 1 - (1 - b) * (1 - a * 0.1)
      }

      if (preset.vignette > 0) {
        const t = clamp01((dist - 0.45) / 0.55)
        const f = 1 - preset.vignette * t * t * (3 - 2 * t)
        r *= f
        g *= f
        b *= f
      }

      if (grainAmp > 0) {
        // Grain is strongest in mid tones, like on real film.
        const n = (rand() + rand() - 1) * grainAmp * (1 - Math.abs(2 * l - 1) * 0.6)
        r += n
        g += n
        b += n
      }

      data[i] = (r0 + (r - r0) * k) * 255
      data[i + 1] = (g0 + (g - g0) * k) * 255
      data[i + 2] = (b0 + (b - b0) * k) * 255
    }
  }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Where the photo goes on the final canvas: a centred square in a white frame for instant film. */
export interface FrameLayout {
  width: number
  height: number
  /** Part of the photo to keep. */
  crop: Rect
  /** Where the kept part is drawn. */
  dest: Rect
}

export function frameLayout(width: number, height: number, instant: boolean): FrameLayout {
  if (!instant) {
    const full = { x: 0, y: 0, width, height }
    return { width, height, crop: full, dest: full }
  }
  const side = Math.min(width, height)
  const crop = { x: Math.round((width - side) / 2), y: Math.round((height - side) / 2), width: side, height: side }
  // SX-70 proportions: thin sides and top, wide bottom strip.
  const border = Math.round(side * 0.06)
  const bottom = Math.round(side * 0.24)
  return {
    width: side + border * 2,
    height: side + border + bottom,
    crop,
    dest: { x: border, y: border, width: side, height: side },
  }
}

/** Date imprint like on 90s point-and-shoot cameras: '26 10 29. */
export function formatDateStamp(takenAt: string, tzOffsetMin: number): string {
  const [y, m, d] = computeDayKey(takenAt, tzOffsetMin).split('-')
  return `'${y.slice(2)} ${m} ${d}`
}

export interface FinishOptions {
  filter: DraftFilter
  /** Date imprint text, drawn when `filter.date` is on. */
  stamp: string
  seed: number
}

/**
 * Applies the look to the pixels and draws the final picture: frame and date imprint included.
 * The caller owns the returned canvas and must release it.
 */
export function finishPhoto(base: ImageData, options: FinishOptions): HTMLCanvasElement {
  const preset = getPreset(options.filter.id)
  const pixels = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height)
  applyFilm(pixels.data, pixels.width, pixels.height, preset, options.filter.strength, options.seed)

  const layout = frameLayout(pixels.width, pixels.height, preset.instantFrame)
  const out = document.createElement('canvas')
  out.width = layout.width
  out.height = layout.height
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D недоступен')

  if (preset.instantFrame) {
    ctx.fillStyle = '#f3f0e7'
    ctx.fillRect(0, 0, layout.width, layout.height)
    const { crop, dest } = layout
    ctx.putImageData(pixels, dest.x - crop.x, dest.y - crop.y, crop.x, crop.y, crop.width, crop.height)
  } else {
    ctx.putImageData(pixels, 0, 0)
  }

  if (options.filter.date) drawDateStamp(ctx, layout.dest, options.stamp)
  return out
}

function drawDateStamp(ctx: CanvasRenderingContext2D, area: Rect, text: string): void {
  const size = Math.max(8, Math.round(Math.min(area.width, area.height) * 0.045))
  const margin = size * 1.1
  ctx.save()
  ctx.font = `bold ${size}px "Courier New", ui-monospace, monospace`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  ctx.globalCompositeOperation = 'lighter'
  const x = area.x + area.width - margin
  const y = area.y + area.height - margin
  // The LED imprint burns orange into the film and glows slightly.
  ctx.shadowColor = 'rgba(255, 80, 0, 0.9)'
  ctx.shadowBlur = size * 0.5
  ctx.fillStyle = 'rgba(255, 120, 30, 0.75)'
  ctx.fillText(text, x, y)
  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(255, 170, 70, 0.6)'
  ctx.fillText(text, x, y)
  ctx.restore()
}

/** Draws the source into a canvas no larger than `maxSide` and returns its pixels. */
export function readPixels(frame: FrameSource, maxSide: number): ImageData {
  const size = fitSize(frame.width, frame.height, maxSide)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Canvas 2D недоступен')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(frame.source, 0, 0, size.width, size.height)
    return ctx.getImageData(0, 0, size.width, size.height)
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

/** Re-encodes the stored original with the look, frame and date imprint applied. */
export async function renderFilteredPhoto(
  original: Blob,
  options: FinishOptions,
  encoder: Encoder = canvasEncoder,
): Promise<ProcessedPhoto> {
  const bitmap = await createImageBitmap(original)
  let canvas: HTMLCanvasElement | undefined
  try {
    const pixels = readPixels({ source: bitmap, width: bitmap.width, height: bitmap.height }, Infinity)
    bitmap.close()
    canvas = finishPhoto(pixels, options)
    return await processFrame({ source: canvas, width: canvas.width, height: canvas.height }, encoder)
  } finally {
    bitmap.close()
    if (canvas) {
      canvas.width = 0
      canvas.height = 0
    }
  }
}
