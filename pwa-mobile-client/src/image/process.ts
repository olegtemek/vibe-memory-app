import type { ProcessedPhoto } from '@/storage/types'

export const ORIGINAL_MAX_SIDE = 2048
export const ORIGINAL_QUALITY = 0.85
export const THUMB_MAX_SIDE = 400
export const THUMB_QUALITY = 0.75
/** Copy kept on the device in place of an original that lives only on the server. */
export const MEDIUM_MAX_SIDE = 1080
export const MEDIUM_QUALITY = 0.8

export interface Size {
  width: number
  height: number
}

/** Scales the size down so the long side is at most `maxSide`. Never upscales. */
export function fitSize(width: number, height: number, maxSide: number): Size {
  if (width <= 0 || height <= 0) throw new Error(`Invalid size ${width}x${height}`)
  const long = Math.max(width, height)
  if (long <= maxSide) return { width, height }
  const scale = maxSide / long
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(data: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data
  return toHex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/** Anything a 2D canvas can draw and that has known dimensions. */
export interface FrameSource {
  source: CanvasImageSource
  width: number
  height: number
}

/** Abstracts canvas creation and encoding so the pipeline is testable. */
export interface Encoder {
  encode(frame: FrameSource, size: Size, quality: number): Promise<Blob>
}

export const canvasEncoder: Encoder = {
  async encode(frame, size, quality) {
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    try {
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas 2D недоступен')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(frame.source, 0, 0, size.width, size.height)
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось сжать кадр'))), 'image/jpeg', quality),
      )
    } finally {
      // Releases the backing store right away; iOS is strict about canvas memory.
      canvas.width = 0
      canvas.height = 0
    }
  },
}

/** Produces the stored original and thumbnail plus their SHA-256 hashes. */
export async function processFrame(frame: FrameSource, encoder: Encoder = canvasEncoder): Promise<ProcessedPhoto> {
  const originalSize = fitSize(frame.width, frame.height, ORIGINAL_MAX_SIDE)
  const thumbSize = fitSize(frame.width, frame.height, THUMB_MAX_SIDE)
  const original = await encoder.encode(frame, originalSize, ORIGINAL_QUALITY)
  const thumb = await encoder.encode(frame, thumbSize, THUMB_QUALITY)
  const [photoHash, thumbHash] = await Promise.all([sha256Hex(original), sha256Hex(thumb)])
  return { original, thumb, photoHash, thumbHash, width: originalSize.width, height: originalSize.height }
}

/** Grabs the current video frame (unmirrored) into a canvas of videoWidth × videoHeight. */
export async function processVideoFrame(video: HTMLVideoElement): Promise<ProcessedPhoto> {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  try {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D недоступен')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return await processFrame({ source: canvas, width: canvas.width, height: canvas.height })
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

/** Fallback path: a file from <input capture>, decoded with EXIF orientation applied. */
export async function processFile(file: Blob): Promise<ProcessedPhoto> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    return await processFrame({ source: bitmap, width: bitmap.width, height: bitmap.height })
  } finally {
    bitmap.close()
  }
}

/** Re-encodes a stored original down to the medium size. */
export async function makeMedium(original: Blob, encoder: Encoder = canvasEncoder): Promise<{ hash: string; blob: Blob }> {
  const bitmap = await createImageBitmap(original)
  try {
    const size = fitSize(bitmap.width, bitmap.height, MEDIUM_MAX_SIDE)
    const blob = await encoder.encode({ source: bitmap, width: bitmap.width, height: bitmap.height }, size, MEDIUM_QUALITY)
    return { hash: await sha256Hex(blob), blob }
  } finally {
    bitmap.close()
  }
}
