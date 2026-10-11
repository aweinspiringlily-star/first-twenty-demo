import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import { fixtureDB } from './testkit'
import { formatDual, interviewICS, proposeTimes, schedulingMessage, scheduleInterview, cancelInterview, setInterviewStatus, zoneLabel } from './scheduling'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

describe('proposeTimes', () => {
  it('proposes 10:00, 1:00 and 3:30 Pacific on the next business days (PDT)', () => {
    expect(proposeTimes('2026-10-09')).toEqual([
      '2026-10-12T17:00:00.000Z', // Mon 10:00 AM PDT
      '2026-10-13T20:00:00.000Z', // Tue 1:00 PM PDT
      '2026-10-14T22:30:00.000Z', // Wed 3:30 PM PDT
    ])
  })

  it('switches to PST after daylight saving time ends on Nov 1, 2026', () => {
    expect(proposeTimes('2026-10-30')).toEqual(['2026-11-02T18:00:00.000Z', '2026-11-03T21:00:00.000Z', '2026-11-04T23:30:00.000Z'])
  })

  it('crosses the March 2026 change correctly', () => {
    expect(proposeTimes('2026-03-05')).toEqual([
      '2026-03-06T18:00:00.000Z', // Fri 10:00 AM PST
      '2026-03-09T20:00:00.000Z', // Mon 1:00 PM PDT
      '2026-03-10T22:30:00.000Z', // Tue 3:30 PM PDT
    ])
  })

  it('skips company holidays and supports more slots', () => {
    const times = proposeTimes('2026-11-25', [{ date: '2026-11-26' }, { date: '2026-11-27' }], 4)
    expect(times).toEqual(['2026-11-30T18:00:00.000Z', '2026-12-01T21:00:00.000Z', '2026-12-02T23:30:00.000Z', '2026-12-03T18:00:00.000Z'])
  })
})

describe('formatDual', () => {
  it('shows Pacific and the candidate zone side by side', () => {
    expect(formatDual('2026-10-13T17:00:00.000Z', 'America/New_York')).toBe('Tue, Oct 13, 10:00 AM PT (1:00 PM ET)')
    expect(formatDual('2026-11-03T21:00:00.000Z', 'America/Chicago')).toBe('Tue, Nov 3, 1:00 PM PT (3:00 PM CT)')
    expect(formatDual('2026-10-13T17:00:00.000Z', 'America/Denver')).toBe('Tue, Oct 13, 10:00 AM PT (11:00 AM MT)')
  })

  it('leaves the second zone off for Pacific or unknown candidates', () => {
    expect(formatDual('2026-10-13T17:00:00.000Z', 'America/Los_Angeles')).toBe('Tue, Oct 13, 10:00 AM PT')
    expect(formatDual('2026-10-13T17:00:00.000Z')).toBe('Tue, Oct 13, 10:00 AM PT')
    expect(formatDual('2026-10-13T17:00:00.000Z', 'Not/AZone')).toBe('Tue, Oct 13, 10:00 AM PT')
  })

  it('shows the candidate date when it differs', () => {
    const s = formatDual('2026-10-13T22:30:00.000Z', 'Asia/Kolkata')
    expect(s.startsWith('Tue, Oct 13, 3:30 PM PT (Wed, Oct 14, 4:00 AM ')).toBe(true)
  })

  it('labels non-US zones with what Intl reports', () => {
    expect(zoneLabel('America/New_York', '2026-10-13T17:00:00.000Z')).toBe('ET')
    expect(zoneLabel('Asia/Kolkata', '2026-10-13T17:00:00.000Z')).toMatch(/GMT\+5:30|IST/)
  })
})

describe('scheduleInterview', () => {
  it('creates the interview, owed scorecards due 24 hours after the end, and a debrief next step', () => {
    let id = ''
    const db = produce(fixtureDB(), (d) => {
      id = scheduleInterview(
        d,
        {
          applicationId: 'a-alex',
          stageId: 'onsite',
          name: 'Onsite',
          startsAt: '2026-10-13T17:00:00.000Z',
          durationMin: 60,
          interviewerIds: ['p-tomas', 'p-priya', 'p-tomas'],
          format: 'onsite',
          attributes: ['System design', { name: 'Security mindset' }],
        },
        { date: '2026-10-09' },
      )
    })
    const interview = db.interviews.find((i) => i.id === id)
    expect(interview?.interviewerIds).toEqual(['p-tomas', 'p-priya'])
    expect(interview?.attributes).toEqual(['System design', 'Security mindset'])
    const cards = db.scorecards.filter((s) => s.interviewId === id)
    expect(cards).toHaveLength(2)
    expect(cards.every((c) => c.dueAt === '2026-10-14T18:00:00.000Z')).toBe(true)
    const app = db.applications.find((a) => a.id === 'a-alex')
    expect(app?.nextStep).toEqual({ text: 'Debrief and decide', dueOn: '2026-10-14', ownerId: 'p-tomas' })
    expect(app?.lastContactOn).toBe('2026-10-09')
    expect(db.activity.at(-1)?.text).toBe('Scheduled onsite with Alex Kim for Tue, Oct 13, 10:00 AM PT')
  })

  it('cancels and marks no-shows, dropping owed scorecards', () => {
    let id = ''
    const base = produce(fixtureDB(), (d) => {
      id = scheduleInterview(
        d,
        { applicationId: 'a-ben', stageId: 'intro', name: 'Intro call', startsAt: '2026-10-13T20:00:00.000Z', durationMin: 30, interviewerIds: ['p-tomas'], format: 'video', attributes: [] },
        { date: '2026-10-09' },
      )
    })
    const cancelled = produce(base, (d) => {
      expect(cancelInterview(d, id, { date: '2026-10-10' })).toBe(true)
    })
    expect(cancelled.interviews.find((i) => i.id === id)?.status).toBe('cancelled')
    expect(cancelled.scorecards.some((s) => s.interviewId === id)).toBe(false)
    const noShow = produce(base, (d) => {
      setInterviewStatus(d, id, 'no_show', { date: '2026-10-13' })
    })
    expect(noShow.scorecards.some((s) => s.interviewId === id)).toBe(false)
    expect(noShow.activity.at(-1)?.text).toBe('Ben Ortiz missed the intro call')
  })
})

describe('schedulingMessage and ICS', () => {
  it('fills the screen invite with dual-zone times and a mailto link', () => {
    const db = fixtureDB()
    const times = proposeTimes('2026-10-09')
    const msg = schedulingMessage(db, 'a-ben', times, { senderId: 'p-founder' })
    expect(msg?.subject).toBe('Intro call for Senior full-stack engineer at Ledgerlark')
    expect(msg?.body).toContain('Hi Ben,')
    expect(msg?.body).toContain('- Mon, Oct 12, 10:00 AM PT')
    expect(msg?.body).toContain('Maya Raman')
    expect(msg?.mailto.startsWith('mailto:ben.ortiz@example.com?subject=')).toBe(true)
  })

  it('shows the candidate zone and offers Calendly as an alternative', () => {
    const db = fixtureDB()
    const msg = schedulingMessage(db, 'a-alex', ['2026-10-13T17:00:00.000Z'], { senderId: 'p-tomas', calendly: 'https://calendly.com/ledgerlark/onsite' })
    expect(msg?.subject).toBe('Next step: onsite for Senior full-stack engineer')
    expect(msg?.body).toContain('- Tue, Oct 13, 10:00 AM PT (1:00 PM ET)')
    expect(msg?.body).toContain('Or pick another time here: https://calendly.com/ledgerlark/onsite')
  })

  it('uses only the Calendly link when no times are given, and a generic note for technical', () => {
    const db = produce(fixtureDB(), (d) => {
      const app = d.applications.find((a) => a.id === 'a-chen')
      if (app) app.stageId = 'technical'
    })
    const msg = schedulingMessage(db, 'a-chen', [], { senderId: 'p-tomas', calendly: 'https://cal.example/x', durationMin: 90 })
    expect(msg?.subject).toBe('Next step: technical for Senior full-stack engineer at Ledgerlark')
    expect(msg?.body).toContain('a 90-minute technical')
    expect(msg?.body).toContain('Pick any time that works for you here: https://cal.example/x')
  })

  it('builds candidate and panel calendar files', () => {
    let id = ''
    const db = produce(fixtureDB(), (d) => {
      id = scheduleInterview(
        d,
        { applicationId: 'a-alex', stageId: 'onsite', name: 'Onsite', startsAt: '2026-10-13T17:00:00.000Z', durationMin: 90, interviewerIds: ['p-tomas'], format: 'onsite', attributes: ['System design'] },
        { date: '2026-10-09' },
      )
    })
    const unfold = (x: string | null) => (x ?? '').replace(/\r\n /g, '')
    const panel = unfold(interviewICS(db, id, 'panel'))
    expect(panel).toContain('DTSTART:20261013T170000Z')
    expect(panel).toContain('DTEND:20261013T183000Z')
    expect(panel).toContain('SUMMARY:Onsite: Alex Kim (Senior full-stack engineer)')
    expect(panel).toContain('Scorecard attributes: System design')
    const cand = unfold(interviewICS(db, id, 'candidate'))
    expect(cand).toContain('SUMMARY:Ledgerlark: Onsite for Senior full-stack engineer')
    expect(cand).toContain('Tomas Herrera (Founding engineer)')
    expect(cand).toContain('99 S Almaden Blvd')
    expect(interviewICS(db, 'nope')).toBeNull()
  })
})
