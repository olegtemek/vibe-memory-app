export const EXPORT_FORMAT = 'photodiary-export'
export const EXPORT_VERSION = 1
/** Upper bound for one archive part. Conservative guess for Safari memory on iPhone; verify on device. */
export const EXPORT_PART_MAX_BYTES = 200 * 1024 * 1024

export interface ExportManifest {
  format: typeof EXPORT_FORMAT
  version: number
  exportedAt: string
  part: number
  totalParts: number
  entryCount: number
}

export const photoPath = (hash: string) => `photos/${hash}.jpg`
export const thumbPath = (hash: string) => `thumbs/${hash}.jpg`
/** 1080 px copies of originals that are kept only on the server; such entries have no file in photos/. */
export const mediumPath = (hash: string) => `medium/${hash}.jpg`
