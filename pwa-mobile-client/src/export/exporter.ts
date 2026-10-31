import { zipSync, strToU8, type Zippable } from 'fflate'
import { repository as defaultRepo, type Repository } from '@/storage/repository'
import { EXPORT_FORMAT, EXPORT_VERSION, mediumPath, photoPath, thumbPath, type ExportManifest } from './format'
import { planParts, type ExportPart } from './plan'

export interface PreparedExport {
  exportedAt: string
  parts: ExportPart[]
}

export async function prepareExport(
  from: string | null,
  to: string | null,
  repo: Repository = defaultRepo,
  maxBytes?: number,
): Promise<PreparedExport> {
  const entries = await repo.listForExport(from, to)
  const hashes = entries
    .filter((e) => e.purgedAt === null)
    .flatMap((e) => (e.mediumHash ? [e.photoHash, e.thumbHash, e.mediumHash] : [e.photoHash, e.thumbHash]))
  const sizes = await repo.blobSizes([...new Set(hashes)])
  return { exportedAt: new Date().toISOString(), parts: planParts(entries, sizes, maxBytes) }
}

/** Builds one ZIP part in memory. Files are stored without compression: JPEG is already compressed. */
export async function buildPart(
  prepared: PreparedExport,
  index: number,
  repo: Repository = defaultRepo,
): Promise<File> {
  const part = prepared.parts[index]!
  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: prepared.exportedAt,
    part: index + 1,
    totalParts: prepared.parts.length,
    entryCount: part.entries.length,
  }
  const files: Zippable = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'entries.json': strToU8(JSON.stringify(part.entries)),
  }
  const add = async (hash: string, path: string) => {
    const blob = await repo.getBlob(hash)
    if (blob) files[path] = new Uint8Array(await blob.arrayBuffer())
  }
  for (const hash of part.photoHashes) await add(hash, photoPath(hash))
  for (const hash of part.thumbHashes) await add(hash, thumbPath(hash))
  for (const hash of part.mediumHashes) await add(hash, mediumPath(hash))

  const zipped = zipSync(files, { level: 0 })
  const stamp = prepared.exportedAt.slice(0, 10)
  const suffix = prepared.parts.length > 1 ? `-part${index + 1}of${prepared.parts.length}` : ''
  return new File([zipped as BlobPart], `vibe-memory-${stamp}${suffix}.zip`, { type: 'application/zip' })
}

/** Hands the file to the share sheet ("Save to Files"); falls back to a download link. */
export async function deliverFile(file: File): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] })
      return 'shared'
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled'
      // Fall through to the download link.
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return 'downloaded'
}
