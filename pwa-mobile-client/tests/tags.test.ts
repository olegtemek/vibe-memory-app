import { describe, expect, it } from 'vitest'
import { extractTags, normalizeTag, splitByTags } from '@/utils/tags'
import { freshRepo, makeDraft } from './helpers'

describe('tags', () => {
  it('extracts unique normalized tags', () => {
    expect(extractTags('Пробежка #Sport #street, снова #sport')).toEqual(['sport', 'street'])
    expect(extractTags('#утро_рано\n#2026')).toEqual(['утро_рано', '2026'])
  })

  it('ignores # inside words and bare #', () => {
    expect(extractTags('a#b # c ##')).toEqual([])
  })

  it('normalizes queries', () => {
    expect(normalizeTag('  #Sport ')).toBe('sport')
    expect(normalizeTag('street')).toBe('street')
  })

  it('splits a comment into text and tags', () => {
    expect(splitByTags('бег #sport!')).toEqual([{ text: 'бег ' }, { text: '#sport', tag: 'sport' }, { text: '!' }])
  })
})

describe('repository tag search', () => {
  it('finds live entries by tag, newest first', async () => {
    const { repo } = freshRepo()
    const old = await repo.createEntry(await makeDraft('1', { comment: 'бег #sport', takenAt: '2026-10-01T10:00:00.000Z' }))
    const fresh = await repo.createEntry(await makeDraft('2', { comment: '#Sport #street', takenAt: '2026-10-20T10:00:00.000Z' }))
    await repo.createEntry(await makeDraft('3', { comment: 'просто #street' }))
    const gone = await repo.createEntry(await makeDraft('4', { comment: '#sport' }))
    await repo.softDelete(gone.id)

    expect((await repo.searchByTag('#SPORT')).map((e) => e.id)).toEqual([fresh.id, old.id])
    expect(await repo.searchByTag('#sports')).toEqual([])
    expect(await repo.listTags()).toEqual([
      { tag: 'sport', count: 2 },
      { tag: 'street', count: 2 },
    ])
  })
})
