import { createDb } from '@/storage/db'
import { createRepository } from '@/storage/repository'
import { sha256Hex } from '@/image/process'
import type { Draft } from '@/storage/types'

let counter = 0

export function freshRepo() {
  const db = createDb(`test-${++counter}-${Math.random()}`)
  return { db, repo: createRepository(db) }
}

export async function makeDraft(seed: string, overrides: Partial<Draft> = {}): Promise<Draft> {
  const original = new Blob([`original-${seed}`], { type: 'image/jpeg' })
  const thumb = new Blob([`thumb-${seed}`], { type: 'image/jpeg' })
  return {
    original,
    thumb,
    photoHash: await sha256Hex(original),
    thumbHash: await sha256Hex(thumb),
    width: 2048,
    height: 1536,
    takenAt: '2026-10-29T10:00:00.000Z',
    tzOffsetMin: 180,
    comment: '',
    ...overrides,
  }
}
