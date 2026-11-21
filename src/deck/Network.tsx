import { useId } from 'react'
import type { Run, Site, Shipment } from '../domain/engine'
const coast =
  'M-50 -50H780V15L727 26 716 44 683 51 669 68 628 76 620 90 638 102 658 99 667 112 650 126 689 143 681 160 655 166 647 181 672 188 690 205 668 221 681 238 650 253 661 271 634 284 604 288 594 305 565 311 548 334 514 343 529 360 508 371 472 372 459 389 421 394 408 415 372 432H-50Z'
function terrain(x: number, y: number) {
  return (
    26 * Math.sin(x / 47 + y / 59) +
    13 * Math.sin(x / 23 - y / 37) +
    8 * Math.cos(x / 18 + y / 30) +
    22 * Math.cos(x / 92 - y / 58)
  )
}
function contours() {
  const paths: string[] = []
  for (let h = -60; h <= 65; h += 5) {
    const lines: string[] = []
    for (let y = -8; y <= 432; y += 8)
      for (let x = -8; x < 776; x += 8) {
        const p = [
            [x, y],
            [x + 8, y],
            [x + 8, y + 8],
            [x, y + 8],
          ],
          hits: number[][] = []
        for (let i = 0; i < 4; i++) {
          const a = p[i],
            b = p[(i + 1) % 4],
            va = terrain(...(a as [number, number])),
            vb = terrain(...(b as [number, number]))
          if (va < h === vb < h) continue
          const k = (h - va) / (vb - va)
          hits.push([a[0] + k * (b[0] - a[0]), a[1] + k * (b[1] - a[1])])
        }
        for (let i = 1; i < hits.length; i += 2)
          lines.push(
            'M' +
              hits[i - 1].map((v) => v.toFixed(1)).join(' ') +
              'L' +
              hits[i].map((v) => v.toFixed(1)).join(' '),
          )
      }
    paths.push(lines.join(' '))
  }
  return paths
}
const contourPaths = contours()
export function Network({
  state,
  selected,
  onSelect,
  onShipment,
  highlight = [],
  compact = false,
}: {
  state: Run
  selected?: string
  onSelect?: (site: Site) => void
  onShipment?: (shipment: Shipment) => void
  highlight?: string[]
  compact?: boolean
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const clip = 'land' + uid,
    grid = 'grid' + uid
  const placedMarkers: { x: number; y: number }[] = []
  const at = (id: string) => state.sites.find((n) => n.id === id)!
  return (
    <div className={'map ' + (compact ? 'mini' : '')}>
      <svg viewBox="0 0 760 424" role="group" aria-label="Interactive coastal supply network">
        <defs>
          <clipPath id={clip}>
            <path d={coast} />
          </clipPath>
          <pattern id={grid} width="38" height="38" patternUnits="userSpaceOnUse">
            <path d="M38 0H0V38" stroke="#557169" strokeWidth=".65" opacity=".36" fill="none" />
          </pattern>
        </defs>
        <rect width="760" height="424" fill="#a9cfd0" />
        {[42, 31, 21, 11].map((w) => (
          <path
            key={w}
            d={coast}
            fill="none"
            stroke={w % 2 ? '#8ebdbf' : '#b6d7d5'}
            strokeWidth={w}
          />
        ))}
        <path d={coast} fill="#eeeede" stroke="#829f93" strokeWidth="1.5" />
        <g clipPath={'url(#' + clip + ')'}>
          {contourPaths.map((d, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={i % 4 === 0 ? '#a4b9a0' : '#bdc8ad'}
              strokeWidth={i % 4 === 0 ? 1.25 : 0.8}
            />
          ))}
          <path
            d="M310 -10Q278 57 321 101T350 185Q320 222 389 258T460 311Q460 363 540 378"
            fill="none"
            stroke="#adc9bd"
            strokeWidth="5"
          />
          {state.sites.map((n) => (
            <g key={n.id} transform={`translate(${n.x} ${n.y}) rotate(-19)`} opacity=".45">
              {Array.from({ length: 14 }, (_, i) => (
                <rect
                  key={i}
                  x={(i % 5) * 9 - 19}
                  y={Math.floor(i / 5) * 9 - 12}
                  width={5 + (i % 3)}
                  height="5"
                  fill="#adaf9c"
                />
              ))}
            </g>
          ))}
        </g>
        <rect width="760" height="424" fill={'url(#' + grid + ')'} />
        <g fontFamily="monospace" fill="#586c63" fontSize="11" letterSpacing="3">
          <text x="38" y="51" transform="rotate(-8 38 51)">
            NORTH RIDGE
          </text>
          <text x="38" y="389">
            SOUTH BASIN
          </text>
          <text x="605" y="355" transform="rotate(-16 605 355)" fill="#497f86">
            TIDAL BAY
          </text>
        </g>
        {state.roads.map((r) => {
          const a = at(r.a),
            b = at(r.b),
            hot = highlight.includes(r.id),
            path = `M${a.x} ${a.y} L${a.x + (b.x - a.x) * 0.48 + 9} ${a.y + (b.y - a.y) * 0.44 - 9} L${b.x} ${b.y}`
          return (
            <g key={r.id}>
              <path d={path} fill="none" stroke="#fffff1" strokeWidth="6" />
              <path
                d={path}
                fill="none"
                stroke={r.blocked ? '#ab4435' : hot ? '#e96c2d' : '#506a64'}
                strokeWidth={hot || r.blocked ? 4 : 2.2}
                strokeDasharray={r.blocked ? '6 5' : undefined}
              />
            </g>
          )
        })}
        {state.sites.map((n) => {
          const isDepot = n.kind === 'depot'
          const label = n.id === 'school' ? 'School Relief' : n.name
          const width = label.length * 6.1 + 14
          return (
            <g
              key={n.id}
              tabIndex={onSelect ? 0 : undefined}
              role={onSelect ? 'button' : undefined}
              aria-label={n.name}
              onClick={() => onSelect?.(n)}
              onKeyDown={(e) => {
                if (onSelect && ['Enter', ' '].includes(e.key)) {
                  e.preventDefault()
                  onSelect(n)
                }
              }}
              className={onSelect ? 'map-pin' : ''}
              transform={`translate(${n.x} ${n.y})`}
            >
              <title>
                {n.name} ·{' '}
                {isDepot
                  ? n.stock + ' units in stock'
                  : n.delivered + ' / ' + n.demand + ' delivered'}
              </title>
              {selected === n.id && (
                <circle
                  r="21"
                  fill="#ef8a42"
                  fillOpacity=".3"
                  stroke="#b55322"
                  strokeDasharray="3 3"
                />
              )}
              {isDepot ? (
                <g>
                  <rect
                    x="-10"
                    y="-10"
                    width="20"
                    height="20"
                    rx="2"
                    fill="#183a39"
                    stroke="#ffffef"
                    strokeWidth="2"
                  />
                  <path d="m-5 -1 5-4 5 4v5H-5z" fill="none" stroke="white" strokeWidth="1.3" />
                </g>
              ) : (
                <g>
                  <circle r="9" fill="#fffaf0" stroke="#254943" strokeWidth="2.2" />
                  <path d="M-4 0h8M0-4v8" stroke="#39665e" strokeWidth="2" />
                </g>
              )}
              <rect
                x={-width / 2}
                y={14}
                width={width}
                height="18"
                rx="2"
                fill="#fbf9ed"
                stroke="#667f72"
                strokeOpacity=".4"
              />
              <text textAnchor="middle" y="27" fontSize="11" fontWeight="700" fill="#263e38">
                {label}
              </text>
            </g>
          )
        })}
        {state.shipments
          .filter((sh) => !sh.delivered)
          .map((sh) => {
            let from = at(sh.from),
              elapsed = Math.max(0, state.tick - sh.departure)
            // Park just outside the depot symbol on the departure turn.
            let x = from.x + 16,
              y = from.y - 12
            for (const id of sh.edges) {
              const edge = state.roads.find((r) => r.id === id)!
              const next = at(edge.a === from.id ? edge.b : edge.a)
              if (elapsed < edge.cost) {
                const fraction = elapsed / edge.cost
                if (fraction > 0) {
                  x = from.x + (next.x - from.x) * fraction
                  y = from.y + (next.y - from.y) * fraction
                } else {
                  x = from.x + 16
                  y = from.y - 12
                }
                break
              }
              elapsed -= edge.cost
              from = next
            }
            // Stack vehicles sharing a map position so every shipment remains clickable.
            while (
              placedMarkers.some(
                (point) => Math.abs(point.x - x) < 26 && Math.abs(point.y - y) < 19,
              )
            )
              y -= 20
            placedMarkers.push({ x, y })
            return (
              <g
                key={sh.id}
                className="map-pin"
                transform={`translate(${x} ${y})`}
                role="button"
                tabIndex={0}
                aria-label={'Inspect shipment ' + sh.id}
                onClick={() => onShipment?.(sh)}
                onKeyDown={(e) => {
                  if (['Enter', ' '].includes(e.key)) {
                    e.preventDefault()
                    onShipment?.(sh)
                  }
                }}
              >
                <title>
                  {sh.id} · {sh.qty} units · ETA {sh.arrival}
                </title>
                <rect
                  x="-12"
                  y="-10"
                  width="24"
                  height="17"
                  rx="4"
                  fill="#ffac6d"
                  stroke="#613f2e"
                />
                <path
                  d="M-8-5h9v7h-9zM1-3h4l3 3v2H1z"
                  fill="none"
                  stroke="#263f32"
                  strokeWidth="1.4"
                />
                <circle cx="-5" cy="3" r="2" fill="#263f32" />
                <circle cx="5" cy="3" r="2" fill="#263f32" />
              </g>
            )
          })}
        <g transform="translate(720 54)" fill="#254b48">
          <path d="M0 -15 6 8 0 4 -6 8z" />
          <text y="-19" textAnchor="middle" fontSize="11">
            N
          </text>
        </g>
      </svg>
    </div>
  )
}
