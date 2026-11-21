import { useEffect, useRef, type ReactNode } from 'react'
import { Compass, Layers, Radio, X } from 'lucide-react'
import type { Identity } from './api'

export function Header({ user }: { user: Identity | null }) {
  return (
    <header className="mast">
      <div className="mast-in">
        <a className="brand" href="/">
          <span className="brand-mark">
            <Layers size={25} strokeWidth={2.5} />
          </span>
          Dispatch<span>Deck</span>
        </a>
        <nav>
          <a href="/dashboard">
            <Radio size={16} />
            Operations
          </a>
          <a href="/#briefing">
            <Compass size={16} />
            Field guide
          </a>
        </nav>
        <span className="operator">
          <span className="dot" />
          {user?.name ?? 'Field station'}
        </span>
      </div>
    </header>
  )
}

/** Native <dialog> shown modally for as long as it is mounted. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return (
    <dialog ref={ref} onCancel={onClose}>
      <div className="dialog-head">
        <h2>{title}</h2>
        <button onClick={onClose} aria-label="Close" className="icon">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  )
}

export function Legend() {
  return (
    <div className="legend">
      <span>
        <i className="key depot" />
        Supply depot
      </span>
      <span>
        <i className="key relief" />
        Relief site
      </span>
      <span>
        <i className="key road" />
        Open road
      </span>
    </div>
  )
}
