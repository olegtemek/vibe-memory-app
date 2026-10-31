export type SyncStatus = 'pending' | 'synced'
/** Set by the server only: `complete` once it has received and verified both files. */
export type ServerStatus = 'partial' | 'complete'
/** Files that go to the server. */
export type BlobKind = 'original' | 'thumb'
/** `medium` is a local stand-in for an original kept only on the server. */
export type StoredBlobKind = BlobKind | 'medium'

export interface Entry {
  id: string
  /** ISO 8601, UTC. */
  takenAt: string
  /** Minutes east of UTC at capture time: -new Date().getTimezoneOffset(). */
  tzOffsetMin: number
  /** YYYY-MM-DD in the local time of capture. Computed once on creation. */
  dayKey: string
  comment: string
  photoHash: string
  thumbHash: string
  width: number
  height: number
  createdAt: string
  updatedAt: string
  deleted: boolean
  purgedAt: string | null
  syncStatus: SyncStatus
  /** Where the photo was taken; null when unknown. Absent in entries made before geolocation existed. */
  location?: GeoPoint | null
  /** Local only: the original is not on the device and lives on the server. */
  offloaded?: boolean
  /** Local only: SHA-256 of the 1080 px copy kept instead of an offloaded original. */
  mediumHash?: string
  /** Local only: server sequence number of the last version the server confirmed. */
  seq?: number
  /** Local only: file status the server last reported for this entry. */
  serverStatus?: ServerStatus
}

export interface GeoPoint {
  lat: number
  lon: number
  /** Radius of uncertainty, metres. */
  accuracy: number
}

/** Fields that exist only on this device and never go to the server. */
export type LocalEntryField = 'syncStatus' | 'offloaded' | 'mediumHash' | 'seq' | 'serverStatus'
/** An entry as the server stores and returns it. */
export type ServerEntry = Omit<Entry, LocalEntryField>

export interface StoredBlob {
  hash: string
  kind: StoredBlobKind
  blob: Blob
  size: number
}

export interface MetaRow {
  key: MetaKey
  value: unknown
}

export type MetaKey =
  | 'schemaVersion'
  | 'persistGranted'
  | 'lastExportAt'
  | 'lastSeq'
  | 'draft'
  | 'server'
  | 'lastUploadAt'

/** Home server the diary uploads to. */
export interface ServerSettings {
  /** Base URL, e.g. https://diary.home.lan:8443 (no trailing slash). */
  url: string
  /** Account token issued by the server, sent as `Authorization: Bearer <token>`. Required. */
  token: string
  /** Upload automatically after changes and when the app opens. */
  autoUpload: boolean
  /** Originals older than this many days are removed from the device once the server has them. null: keep all. */
  keepOriginalsDays?: number | null
}

/** A processed photo ready to be stored: original + thumbnail with their hashes. */
export interface ProcessedPhoto {
  original: Blob
  thumb: Blob
  photoHash: string
  thumbHash: string
  width: number
  height: number
}

export type FilmFilterId =
  | 'none'
  | 'portra'
  | 'gold'
  | 'superia'
  | 'cine'
  | 'hp5'
  | 'expired'
  | 'contax-t2'
  | 'mju-ii'
  | 'leica-m6'
  | 'lomo'
  | 'disposable'
  | 'polaroid'

/** Film look chosen for a draft. Applied to the original only when the entry is saved. */
export interface DraftFilter {
  id: FilmFilterId
  /** 0..1: blend between the original and the full effect. */
  strength: number
  /** Orange date imprint in the corner, as on 90s point-and-shoot cameras. */
  date?: boolean
}

/** A captured but not yet saved frame. Survives iOS unloading the app. */
export interface Draft extends ProcessedPhoto {
  takenAt: string
  tzOffsetMin: number
  comment: string
  /** Absent in drafts made before filters existed. */
  filter?: DraftFilter
  location?: GeoPoint | null
}

export interface DayGroup {
  dayKey: string
  entries: Entry[]
}

export interface UsageInfo {
  usage: number | null
  quota: number | null
  entryCount: number
  persisted: boolean | null
  /** Live entries whose original is only on the server. */
  offloadedCount: number
}

export const COMMENT_MAX_LENGTH = 5000
