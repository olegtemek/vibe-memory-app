import type { Entry } from '@/storage/types'

/** The server has received and verified both files of the entry. A later comment edit does not change this. */
export const isOnServer = (e: Pick<Entry, 'serverStatus'>) => e.serverStatus === 'complete'
