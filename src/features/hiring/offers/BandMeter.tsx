// Position-in-band meter: the band as a track, the offer as a solid dot, desired pay as a marker and
// peers at the level as unnamed hollow dots (Admin only). Everything sits inside <Private> so the
// privacy blur (B) hides it. Numbers are also given as text, so the marks are never the only channel.
import type { ReactNode } from 'react'
import type { Band } from '@/domain/types'
import { moneyShort, pct, plural } from '@/lib/format'
import { usePrefs } from '@/store/prefs'
import { cx } from '@/ui'
import { bandMeterGeometry, bandWords } from './logic'

export function BandMeter({
  band,
  offer,
  desired,
  peers,
  compact,
}: {
  band: Pick<Band, 'min' | 'mid' | 'max'>
  offer: number | null | undefined
  desired?: number | null
  /** Unnamed peer bases at this level; undefined hides peers (non-admin views). */
  peers?: number[]
  compact?: boolean
}) {
  // Native tooltips sit outside the blur filter, so the marks carry no amounts while the blur is on.
  const blur = usePrefs((s) => s.privacyBlur)
  const tip = (text: string) => (blur ? undefined : text)
  const g = bandMeterGeometry(band)
  const left = (v: number) => `${g.at(v) * 100}%`
  const pos = offer != null && band.max > band.min ? (offer - band.min) / (band.max - band.min) : null
  const words = offer != null ? bandWords(offer, band) : 'No base yet'
  const summary = [
    offer != null ? `Offer ${moneyShort(offer)}: ${words.toLowerCase()}${pos != null && pos >= 0 && pos <= 1 ? `, ${pct(pos, 0)} of the way from minimum to maximum` : ''}.` : 'No base yet.',
    `Band ${moneyShort(band.min)} to ${moneyShort(band.max)}, midpoint ${moneyShort(band.mid)}.`,
    desired != null ? `Desired pay ${moneyShort(desired)}.` : '',
    peers ? `${plural(peers.length, 'peer')} at this level.` : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <PrivateBlock>
      <div role="img" aria-label={blur ? 'Position in band, hidden by privacy blur' : summary} className={compact ? 'pt-6 pb-5' : 'pt-7 pb-6'}>
        <div className="relative h-3">
          {/* Track and the band itself */}
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-surface-3" />
          <div
            className="absolute top-1/2 h-3 -translate-y-1/2 rounded-sm bg-accent-soft ring-1 ring-inset ring-accent/30"
            style={{ left: left(band.min), width: `${(g.at(band.max) - g.at(band.min)) * 100}%` }}
          />
          <div className="absolute top-1/2 h-4 w-[2px] -translate-x-1/2 -translate-y-1/2 bg-ink-3" style={{ left: left(band.mid) }} title={tip(`Midpoint ${moneyShort(band.mid)}`)} />
          {/* Peers: unnamed hollow dots */}
          {peers?.map((p, i) => (
            <span
              key={`${p}-${i}`}
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink-3 bg-surface"
              style={{ left: left(p) }}
              title="A peer at this level"
            />
          ))}
          {/* Desired pay: a marker above the track */}
          {desired != null && (
            <span className="absolute -top-2.5 flex -translate-x-1/2 flex-col items-center" style={{ left: left(desired) }} title={tip(`Desired pay ${moneyShort(desired)}`)}>
              <span className="h-0 w-0 border-x-[6px] border-t-[8px] border-x-transparent border-t-ink" />
              <span className="h-4 w-[2px] bg-ink" />
            </span>
          )}
          {/* The offer: solid dot with a surface ring */}
          {offer != null && (
            <span
              className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface"
              style={{ left: left(offer) }}
              title={tip(`This offer ${moneyShort(offer)}${g.clipped(offer) ? ' (off the scale)' : ''}`)}
            />
          )}
          {offer != null && (
            <span className="num absolute -top-6 -translate-x-1/2 text-[12px] font-bold whitespace-nowrap text-ink" style={{ left: `clamp(24px, ${left(offer)}, calc(100% - 24px))` }}>
              {moneyShort(offer)}
            </span>
          )}
        </div>
        <div className="num relative mt-2 h-4 text-[11.5px] text-ink-3">
          <span className="absolute -translate-x-1/2" style={{ left: left(band.min) }}>
            {moneyShort(band.min)}
          </span>
          <span className="absolute -translate-x-1/2" style={{ left: left(band.mid) }}>
            {moneyShort(band.mid)}
          </span>
          <span className="absolute -translate-x-1/2" style={{ left: left(band.max) }}>
            {moneyShort(band.max)}
          </span>
        </div>
      </div>
      {!compact && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2" aria-hidden>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-accent" />
            This offer
          </span>
          {desired != null && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-ink" />
              Desired pay
            </span>
          )}
          {peers && peers.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full border-2 border-ink-3" />
              Peers at this level (unnamed)
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-[2px] bg-ink-3" />
            Midpoint
          </span>
        </div>
      )}
      <p className="mt-1 text-[13px] text-ink-2">{summary}</p>
    </PrivateBlock>
  )
}

/** Block-level twin of <Private>: the privacy blur (B) hides everything inside. */
export function PrivateBlock({ children, className }: { children: ReactNode; className?: string }) {
  const blur = usePrefs((s) => s.privacyBlur)
  return (
    <div className={cx('ft-private ft-private--block num transition-[filter]', blur && 'ft-private--on select-none blur-[6px]', className)} aria-hidden={blur || undefined} title={blur ? 'Hidden by privacy blur (press B)' : undefined}>
      {children}
    </div>
  )
}
