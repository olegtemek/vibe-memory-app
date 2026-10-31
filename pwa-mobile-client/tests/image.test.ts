import { describe, expect, it } from 'vitest'
import {
  fitSize,
  processFrame,
  sha256Hex,
  ORIGINAL_QUALITY,
  THUMB_QUALITY,
  type Encoder,
} from '@/image/process'

describe('fitSize', () => {
  it('keeps small images as is', () => {
    expect(fitSize(800, 600, 2048)).toEqual({ width: 800, height: 600 })
  })
  it('limits the long side for landscape and portrait', () => {
    expect(fitSize(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 })
    expect(fitSize(3024, 4032, 400)).toEqual({ width: 300, height: 400 })
  })
  it('rejects empty sizes', () => {
    expect(() => fitSize(0, 10, 100)).toThrow()
  })
})

describe('sha256Hex', () => {
  it('matches the known digest', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
  it('hashes blobs the same as bytes', async () => {
    const bytes = new TextEncoder().encode('photo')
    expect(await sha256Hex(new Blob([bytes]))).toBe(await sha256Hex(bytes))
  })
})

describe('processFrame', () => {
  it('encodes original and thumb with the right sizes and quality', async () => {
    const calls: Array<{ w: number; h: number; q: number }> = []
    const encoder: Encoder = {
      async encode(_f, size, quality) {
        calls.push({ w: size.width, h: size.height, q: quality })
        return new Blob([`${size.width}x${size.height}`], { type: 'image/jpeg' })
      },
    }
    const result = await processFrame({ source: {} as CanvasImageSource, width: 4096, height: 3072 }, encoder)
    expect(calls).toEqual([
      { w: 2048, h: 1536, q: ORIGINAL_QUALITY },
      { w: 400, h: 300, q: THUMB_QUALITY },
    ])
    expect(result.width).toBe(2048)
    expect(result.height).toBe(1536)
    expect(result.photoHash).toBe(await sha256Hex(result.original))
    expect(result.thumbHash).toBe(await sha256Hex(result.thumb))
  })
})
