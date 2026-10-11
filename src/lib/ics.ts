// Minimal iCalendar (.ics) builder for interviews, time off and compliance deadlines.
// Timed events are written in UTC; all-day events use DATE values.

export type ICSEvent = {
  uid: string
  title: string
  description?: string
  location?: string
  /** Timed event: ISO timestamps. */
  start?: string
  end?: string
  /** All-day event: 'YYYY-MM-DD' (end is exclusive; defaults to the next day). */
  date?: string
  endDate?: string
  attendees?: Array<{ name: string; email: string }>
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

function utc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function ymd(d: string): string {
  return d.replace(/-/g, '')
}

function nextDay(d: string): string {
  const [y, m, day] = d.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, day + 1))
  return dt.toISOString().slice(0, 10)
}

/** Folds long lines at 75 octets as RFC 5545 requires. */
function fold(line: string): string {
  if (line.length <= 74) return line
  const parts: string[] = []
  let rest = line
  parts.push(rest.slice(0, 74))
  rest = rest.slice(74)
  while (rest.length > 73) {
    parts.push(` ${rest.slice(0, 73)}`)
    rest = rest.slice(73)
  }
  if (rest) parts.push(` ${rest}`)
  return parts.join('\r\n')
}

export function buildICS(events: ICSEvent[], calendarName = 'First Twenty'): string {
  const stamp = utc(new Date().toISOString())
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//First Twenty//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(calendarName)}`]
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@first-twenty`, `DTSTAMP:${stamp}`, `SUMMARY:${esc(e.title)}`)
    if (e.date) {
      lines.push(`DTSTART;VALUE=DATE:${ymd(e.date)}`, `DTEND;VALUE=DATE:${ymd(e.endDate ?? nextDay(e.date))}`)
    } else if (e.start) {
      lines.push(`DTSTART:${utc(e.start)}`, `DTEND:${utc(e.end ?? e.start)}`)
    }
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`)
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`)
    for (const a of e.attendees ?? []) lines.push(`ATTENDEE;CN=${esc(a.name)};RSVP=TRUE:mailto:${a.email}`)
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}
