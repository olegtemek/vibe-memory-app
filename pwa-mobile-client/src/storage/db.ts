import Dexie, { type EntityTable } from 'dexie'
import type { Entry, MetaRow, StoredBlob } from './types'

export const SCHEMA_VERSION = 1

export type VibeMemoryDB = Dexie & {
  entries: EntityTable<Entry, 'id'>
  blobs: EntityTable<StoredBlob, 'hash'>
  meta: EntityTable<MetaRow, 'key'>
}

// Never rename the default: a new name opens an empty database, and photos not yet uploaded are lost.
export function createDb(name = 'photodiary'): VibeMemoryDB {
  const db = new Dexie(name) as VibeMemoryDB
  // Every schema change must bump the version and come with an upgrade() migration.
  db.version(1)
    .stores({
      entries: 'id, dayKey, takenAt, updatedAt, syncStatus',
      blobs: 'hash',
      meta: 'key',
    })
    .upgrade(async (tx) => {
      await tx.table('meta').put({ key: 'schemaVersion', value: 1 })
    })
  db.on('populate', (tx) => {
    void tx.table('meta').put({ key: 'schemaVersion', value: SCHEMA_VERSION })
  })
  return db
}

export const db = createDb()
