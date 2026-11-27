import type { SessionNote } from '../types'

export const folderNameOf = (path: string): string =>
  path.split('/').filter(Boolean).pop() ?? ''

export const toText = (stored: unknown): string =>
  typeof stored === 'string' ? stored : ''

// A session's record as it is kept now, read from what any version stored;
// none where what is stored does not read as one.
export const toNote = (stored: unknown): SessionNote | undefined => {
  if (typeof stored !== 'object' || stored === null) return undefined
  // A record written before only the folder's name was kept holds the whole
  // path as `cwd`; its last part is all that is read from it.
  const folder =
    'folder' in stored && typeof stored.folder === 'string'
      ? stored.folder
      : 'cwd' in stored && typeof stored.cwd === 'string'
        ? folderNameOf(stored.cwd)
        : undefined
  if (folder === undefined) return undefined
  // `changedAt` is what a note written before `usedAt` carries.
  const usedAt =
    'usedAt' in stored
      ? stored.usedAt
      : 'changedAt' in stored
        ? stored.changedAt
        : undefined
  if (typeof usedAt !== 'number') return undefined
  const isNameCustom = 'isNameCustom' in stored && stored.isNameCustom === true
  // An earlier version could name a session by the start of its first
  // prompt. Only a name marked as read from the transcript is kept, or one
  // the person gave with /rename, which was always read from there.
  const isNameFromTitle =
    isNameCustom ||
    ('isNameFromTitle' in stored && stored.isNameFromTitle === true)
  const name =
    isNameFromTitle && 'name' in stored && typeof stored.name === 'string'
      ? stored.name
      : undefined
  const note: SessionNote = { folder, usedAt }
  if (name !== undefined) {
    note.name = name
    note.isNameFromTitle = true
  }
  if (isNameCustom) note.isNameCustom = true

  return note
}
