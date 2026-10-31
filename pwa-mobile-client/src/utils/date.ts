const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Minutes east of UTC for the given moment, as stored in Entry.tzOffsetMin. */
export function currentTzOffsetMin(date = new Date()): number {
  return -date.getTimezoneOffset()
}

/** Wall-clock parts of an instant shifted to the given offset. */
function shifted(takenAt: string, tzOffsetMin: number): Date {
  return new Date(Date.parse(takenAt) + tzOffsetMin * 60_000)
}

/** YYYY-MM-DD in the local time of capture. */
export function computeDayKey(takenAt: string, tzOffsetMin: number): string {
  const d = shifted(takenAt, tzOffsetMin)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** HH:MM in the local time of capture. */
export function formatTime(takenAt: string, tzOffsetMin: number): string {
  const d = shifted(takenAt, tzOffsetMin)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']

function parseDayKey(dayKey: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!))
}

/** "29 октября, четверг"; the year is added when it is not the current one. */
export function formatDayTitle(dayKey: string, now = new Date()): string {
  const d = parseDayKey(dayKey)
  const year = d.getUTCFullYear() === now.getFullYear() ? '' : ` ${d.getUTCFullYear()}`
  return `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]}${year}, ${WEEKDAYS[d.getUTCDay()]}`
}

/** "29 октября 2026, 14:05" in the local time of capture. */
export function formatDateTime(takenAt: string, tzOffsetMin: number): string {
  const d = shifted(takenAt, tzOffsetMin)
  return `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${formatTime(takenAt, tzOffsetMin)}`
}

/** Russian plural form: plural(5, ['фото', 'фото', 'фото']). */
export function plural(n: number, forms: [string, string, string]): string {
  const n10 = n % 10
  const n100 = n % 100
  if (n10 === 1 && n100 !== 11) return forms[0]
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1]
  return forms[2]
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return '—'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** Today's dayKey in the device's current time zone. */
export function todayDayKey(now = new Date()): string {
  return computeDayKey(now.toISOString(), currentTzOffsetMin(now))
}

const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
]

/** "Октябрь 2026" for a dayKey of that month. */
export function formatMonthTitle(dayKey: string): string {
  const d = parseDayKey(dayKey)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/**
 * Calendar weeks (Monday first) of the month containing dayKey.
 * Each week has 7 slots; slots outside the month are null.
 */
export function monthWeeks(dayKey: string): Array<Array<string | null>> {
  const d = parseDayKey(dayKey)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7
  const slots: Array<string | null> = Array(lead).fill(null)
  for (let day = 1; day <= daysInMonth; day++) slots.push(`${y}-${pad(m + 1)}-${pad(day)}`)
  while (slots.length % 7) slots.push(null)
  const weeks: Array<Array<string | null>> = []
  for (let i = 0; i < slots.length; i += 7) weeks.push(slots.slice(i, i + 7))
  return weeks
}

/** Month name in the nominative case, month index 0..11. */
export function monthName(monthIndex: number): string {
  return MONTHS[monthIndex]!
}

/** YYYY-MM of a dayKey. */
export function monthKeyOf(dayKey: string): string {
  return dayKey.slice(0, 7)
}

export function isMonthKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

/** Moves a YYYY-MM key by `delta` months. */
export function shiftMonth(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number)
  const total = y! * 12 + (m! - 1) + delta
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`
}

/** Photo count for small badges: 99+ above 99. */
export function formatBadgeCount(n: number): string {
  return n > 99 ? '99+' : String(n)
}
