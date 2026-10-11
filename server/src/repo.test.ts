// Repository edge cases the HTTP tests do not reach easily: truncated pulls and version history.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import type { Db } from './db'
import { applyChanges, changesSince, replaceWorkspace, snapshot } from './repo'
import { makeTestDb, resetDb } from './test/helpers'
import { parseChanges, parseWorkspace } from './validate'

let db: Db
beforeAll(async () => {
  db = await makeTestDb()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  await resetDb(db)
})

const workspace0 = () => blankDB({ companyName: 'Repoco', founderFirstName: 'R', founderLastName: 'Po', foundedOn: '2026-01-05' })
const workspace = () => parseWorkspace({ db: workspace0() })
const job = (id: string) => ({ collection: 'jobs', id, op: 'upsert', data: { id, title: `Job ${id}` }, baseVersion: null })

describe('repo', () => {
  it('returns null before the first upload', async () => {
    expect(await snapshot(db)).toBeNull()
  })

  it('pages pulls: more is set and seq is the last change returned', async () => {
    const { seq } = await replaceWorkspace(db, workspace(), null)
    await applyChanges(db, parseChanges({ changes: [job('j-1'), job('j-2'), job('j-3'), job('j-4'), job('j-5')] }), null)
    const page1 = await changesSince(db, seq, { limit: 2 })
    expect(page1).toMatchObject({ more: true, seq: seq + 2 })
    if ('resync' in page1) throw new Error('unexpected resync')
    expect(page1.changes.map((c) => c.id)).toEqual(['j-1', 'j-2'])
    const page2 = await changesSince(db, page1.seq, { limit: 2 })
    if ('resync' in page2) throw new Error('unexpected resync')
    expect(page2.changes.map((c) => c.id)).toEqual(['j-3', 'j-4'])
    const page3 = await changesSince(db, page2.seq, { limit: 2 })
    expect(page3).toEqual({ historyId: expect.any(String), seq: seq + 5, changes: [expect.objectContaining({ id: 'j-5' })] })
  })

  it('keeps versions growing across delete and re-create, so echoes are recognizable', async () => {
    await replaceWorkspace(db, workspace(), null)
    const a = await applyChanges(db, parseChanges({ changes: [job('j-1')] }), null)
    // A version is the seq of the write that produced it.
    expect(a.applied[0].version).toBe(a.seq)
    const d = await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-1', op: 'delete', baseVersion: a.seq }] }), null)
    expect(d.applied[0].version).toBe(d.seq)
    expect(d.applied[0].version).toBeGreaterThan(a.applied[0].version)
    const again = await applyChanges(db, parseChanges({ changes: [job('j-1')] }), null)
    expect(again.applied[0].version).toBeGreaterThan(d.applied[0].version)
  })

  it('applies a batch change by change: accepted ones commit, rejected ones become conflicts', async () => {
    await replaceWorkspace(db, workspace(), null)
    const r = await applyChanges(
      db,
      parseChanges({
        changes: [job('j-1'), { collection: 'people', id: 'p-founder', op: 'delete', baseVersion: 0 }, job('j-2')],
      }),
      null,
    )
    expect(r.applied.map((x) => x.id)).toEqual(['j-1', 'j-2'])
    expect(r.conflicts).toEqual([expect.objectContaining({ id: 'p-founder', serverVersion: expect.any(Number) })])
    const snap = await snapshot(db)
    expect(snap?.db.jobs).toEqual([
      { id: 'j-1', title: 'Job j-1' },
      { id: 'j-2', title: 'Job j-2' },
    ])
  })

  it('never repeats a version across a full replace, so a stale baseVersion cannot match a newer write', async () => {
    const first = await replaceWorkspace(db, workspace(), null)
    const before = first.versions['people:p-founder']
    const replaced = await replaceWorkspace(db, parseWorkspace({ db: workspace0(), confirmReplace: true }), null)
    const after = replaced.versions['people:p-founder']
    expect(after).toBeGreaterThan(first.seq)
    // Every version in the new workspace is unique and newer than anything from before the replace.
    const values = Object.values(replaced.versions)
    expect(new Set(values).size).toBe(values.length)
    expect(Math.min(...values)).toBeGreaterThan(first.seq)
    expect(Math.max(...values)).toBe(replaced.seq)
    expect(replaced.historyId).not.toBe(first.historyId)
    // An edit based on the old version is a conflict, not an overwrite.
    const stale = await applyChanges(
      db,
      parseChanges({ changes: [{ collection: 'people', id: 'p-founder', op: 'delete', baseVersion: before }] }),
      null,
    )
    expect(stale.applied).toEqual([])
    expect(stale.conflicts).toEqual([expect.objectContaining({ id: 'p-founder', serverVersion: after })])
  })

  it('forgets earlier copies of a deleted record, keeping only the delete', async () => {
    const { seq } = await replaceWorkspace(db, workspace(), null)
    const salary = { collection: 'jobs', id: 'j-pay', op: 'upsert', data: { id: 'j-pay', title: 'Pay', salary: 187_654 }, baseVersion: null }
    const created = await applyChanges(db, parseChanges({ changes: [salary] }), null)
    const v1 = created.applied[0].version
    const edited = await applyChanges(db, parseChanges({ changes: [{ ...salary, data: { id: 'j-pay', title: 'Pay', salary: 191_357 }, baseVersion: v1 }] }), null)
    const v2 = edited.applied[0].version
    const deleted = await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-pay', op: 'delete', baseVersion: v2 }] }), null)
    const rows = await db.query<{ op: string; version: unknown; data: unknown }>(`SELECT op, version, data FROM change_log WHERE record_id = 'j-pay' ORDER BY seq`)
    expect(rows.rows).toEqual([{ op: 'delete', version: expect.anything(), data: null }])
    expect(Number(rows.rows[0].version)).toBe(deleted.applied[0].version)
    expect((await db.query(`SELECT 1 FROM change_log WHERE data::text LIKE '%187654%' OR data::text LIKE '%191357%'`)).rows).toHaveLength(0)
    // A pull from before the deletes gets the delete; re-creating still gets a newer version.
    const pull = await changesSince(db, seq)
    if ('resync' in pull) throw new Error('unexpected resync')
    expect(pull.changes.filter((c) => c.id === 'j-pay')).toEqual([expect.objectContaining({ op: 'delete', version: deleted.applied[0].version })])
    const back = await applyChanges(db, parseChanges({ changes: [{ ...salary, baseVersion: v2 }] }), null)
    expect(back.applied[0].version).toBeGreaterThan(deleted.applied[0].version)
  })

  it('removes the replaced workspace from the change log on a full replace', async () => {
    const first = await replaceWorkspace(db, workspace(), null)
    await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-old', op: 'upsert', data: { id: 'j-old', salary: 187_654 }, baseVersion: null }] }), null)
    const before = await db.query<{ last_seq: unknown }>('SELECT last_seq FROM workspaces')
    const replaced = await replaceWorkspace(db, parseWorkspace({ db: { ...workspace0(), people: [] }, confirmReplace: true }), null)
    const oldest = await db.query<{ seq: unknown }>('SELECT min(seq) AS seq FROM change_log')
    expect(Number(oldest.rows[0].seq)).toBeGreaterThan(Number(before.rows[0].last_seq))
    expect((await db.query(`SELECT 1 FROM change_log WHERE data::text LIKE '%187654%' OR record_id = 'j-old'`)).rows).toHaveLength(0)
    const ws = await db.query<{ pruned_seq: unknown; reset_seq: unknown }>('SELECT pruned_seq, reset_seq FROM workspaces')
    expect(Number(ws.rows[0].pruned_seq)).toBe(Number(before.rows[0].last_seq))
    expect(Number(ws.rows[0].reset_seq)).toBe(replaced.seq)
    expect(await changesSince(db, first.seq)).toEqual({ resync: true })
  })

  it('tells a client from another history to resync, and refuses its pushes', async () => {
    const first = await replaceWorkspace(db, workspace(), null)
    const ok = await changesSince(db, first.seq, { historyId: first.historyId })
    expect(ok).toEqual({ historyId: first.historyId, seq: first.seq, changes: [] })
    expect(await changesSince(db, first.seq, { historyId: '00000000-0000-4000-8000-000000000000' })).toEqual({ resync: true })
    await expect(
      applyChanges(db, parseChanges({ changes: [job('j-1')] }), null, { historyId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'resync' })
    expect((await db.query(`SELECT 1 FROM jobs WHERE id = 'j-1'`)).rows).toHaveLength(0)
    const pushed = await applyChanges(db, parseChanges({ changes: [job('j-1')] }), null, { historyId: first.historyId })
    expect(pushed.historyId).toBe(first.historyId)
    expect(pushed.applied).toHaveLength(1)
  })
})
