import { describe, expect, it } from 'vitest'
import {
  applyFilm,
  FILM_PRESETS,
  formatDateStamp,
  frameLayout,
  getPreset,
  isIdentity,
  mulberry32,
  seedFromHash,
} from '@/image/filters'

function solid(width: number, height: number, rgb: [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i)
  return data
}

describe('film presets', () => {
  it('have unique ids and include the original', () => {
    const ids = FILM_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toBe('none')
  })

  it('falls back to the original for unknown ids', () => {
    expect(getPreset('nope' as never).id).toBe('none')
  })

  it('detects filters that change nothing', () => {
    expect(isIdentity(undefined)).toBe(true)
    expect(isIdentity({ id: 'none', strength: 1 })).toBe(true)
    expect(isIdentity({ id: 'none', strength: 1, date: true })).toBe(false)
    expect(isIdentity({ id: 'portra', strength: 0.5 })).toBe(false)
  })

  it('split into film stocks and cameras', () => {
    expect(FILM_PRESETS.filter((p) => p.group === 'film').length).toBeGreaterThan(2)
    expect(FILM_PRESETS.filter((p) => p.group === 'camera').length).toBeGreaterThan(2)
  })
})

describe('applyFilm', () => {
  it('leaves pixels untouched for the original and zero strength', () => {
    const data = solid(4, 4, [200, 100, 50])
    const copy = data.slice()
    applyFilm(data, 4, 4, getPreset('none'))
    applyFilm(data, 4, 4, getPreset('expired'), 0)
    expect(data).toEqual(copy)
  })

  it('makes black and white film grey', () => {
    const data = solid(8, 8, [220, 40, 40])
    applyFilm(data, 8, 8, getPreset('hp5'))
    for (let i = 0; i < data.length; i += 4) {
      expect(data[i]).toBe(data[i + 1])
      expect(data[i + 1]).toBe(data[i + 2])
    }
  })

  it('warms the image with Portra', () => {
    const data = solid(8, 8, [128, 128, 128])
    applyFilm(data, 8, 8, { ...getPreset('portra'), grain: 0, vignette: 0 })
    expect(data[0]).toBeGreaterThan(data[2])
  })

  it('lifts blacks with a faded preset', () => {
    const data = solid(4, 4, [0, 0, 0])
    applyFilm(data, 4, 4, { ...getPreset('expired'), grain: 0, vignette: 0 })
    expect(data[0]).toBeGreaterThan(20)
  })

  it('darkens corners with vignette', () => {
    const data = solid(21, 21, [180, 180, 180])
    applyFilm(data, 21, 21, { ...getPreset('hp5'), grain: 0 })
    const center = (10 * 21 + 10) * 4
    expect(data[0]).toBeLessThan(data[center])
  })

  it('blends with partial strength', () => {
    const full = solid(4, 4, [128, 128, 128])
    const half = full.slice()
    const preset = { ...getPreset('portra'), grain: 0, vignette: 0 }
    applyFilm(full, 4, 4, preset, 1)
    applyFilm(half, 4, 4, preset, 0.5)
    expect(Math.abs(half[0] - (128 + (full[0] - 128) / 2))).toBeLessThanOrEqual(1)
  })

  it('produces the same grain for the same seed and keeps alpha', () => {
    const a = solid(16, 16, [128, 128, 128])
    const b = a.slice()
    applyFilm(a, 16, 16, getPreset('superia'), 1, 7)
    applyFilm(b, 16, 16, getPreset('superia'), 1, 7)
    expect(a).toEqual(b)
    for (let i = 3; i < a.length; i += 4) expect(a[i]).toBe(255)
  })
})

describe('camera effects', () => {
  const plain = { ...getPreset('none'), id: 'portra' as const }

  it('adds a red glow around highlights with halation', () => {
    const w = 64
    const data = new Uint8ClampedArray(w * w * 4)
    for (let i = 0; i < data.length; i += 4) data.set([20, 20, 20, 255], i)
    // A bright light source in the middle.
    for (let y = 28; y < 36; y++) for (let x = 28; x < 36; x++) data.set([255, 255, 255, 255], (y * w + x) * 4)
    applyFilm(data, w, w, { ...plain, halation: 1 })
    const near = (32 * w + 40) * 4
    expect(data[near]).toBeGreaterThan(data[near + 2] + 10)
    expect(data[0]).toBeLessThan(25)
  })

  it('adds a light leak that brightens one edge', () => {
    const data = solid(40, 40, [60, 60, 60])
    applyFilm(data, 40, 40, { ...plain, lightLeak: 1 }, 1, 3)
    const max = Math.max(...Array.from({ length: 40 * 40 }, (_, p) => data[p * 4]))
    expect(max).toBeGreaterThan(120)
    const center = (20 * 40 + 20) * 4
    expect(data[center]).toBeLessThan(max)
  })

  it('softens detail with a soft lens', () => {
    const w = 32
    const data = new Uint8ClampedArray(w * w * 4)
    for (let p = 0; p < w * w; p++) data.set(p % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], p * 4)
    applyFilm(data, w, w, { ...plain, softness: 1 })
    expect(data[0]).toBeGreaterThan(40)
    expect(data[4]).toBeLessThan(215)
  })
})

describe('frameLayout', () => {
  it('keeps the photo as is for regular cameras', () => {
    const l = frameLayout(400, 300, false)
    expect(l).toMatchObject({ width: 400, height: 300, crop: { x: 0, y: 0, width: 400, height: 300 } })
  })

  it('crops a centred square into an instant film frame', () => {
    const l = frameLayout(400, 300, true)
    expect(l.crop).toEqual({ x: 50, y: 0, width: 300, height: 300 })
    expect(l.dest).toEqual({ x: 18, y: 18, width: 300, height: 300 })
    expect(l.width).toBe(336)
    expect(l.height).toBe(300 + 18 + 72)
  })
})

describe('formatDateStamp', () => {
  it('uses the local date of capture', () => {
    expect(formatDateStamp('2026-10-29T22:30:00.000Z', 180)).toBe("'26 10 30")
    expect(formatDateStamp('2026-01-05T10:00:00.000Z', 0)).toBe("'26 01 05")
  })
})

describe('seedFromHash', () => {
  it('is stable and never zero', () => {
    expect(seedFromHash('00000000ff')).toBe(1)
    expect(seedFromHash('ba7816bf8f01')).toBe(0xba7816bf)
  })
})

describe('mulberry32', () => {
  it('returns values in [0, 1)', () => {
    const rand = mulberry32(42)
    for (let i = 0; i < 1000; i++) {
      const v = rand()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
