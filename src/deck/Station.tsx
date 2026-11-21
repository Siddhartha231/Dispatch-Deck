import { useState, type FormEvent } from 'react'
import { AuthOverlay } from 'deepspace'
import { deck, message, type Identity } from './api'
import { Modal } from './ui'

/**
 * Opens a training station (a signed, browser-bound guest identity) or hands
 * off to DeepSpace sign-in.
 */
export function Station({
  onDone,
  onClose,
}: {
  onDone: (user: Identity) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [oauth, setOauth] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onDone(await deck.station({ name: name.trim() }))
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  function signIn() {
    // DeepSpace sign-in returns to /home; main.tsx sends the user back here.
    sessionStorage.setItem(
      'deck-return',
      location.pathname === '/' ? '/dashboard' : location.pathname,
    )
    setOauth(true)
  }

  if (oauth) return <AuthOverlay onClose={() => setOauth(false)} />
  return (
    <Modal title="Open an operator station" onClose={onClose}>
      <p>Choose the call sign your crew will see. This browser keeps your station for 30 days.</p>
      <form onSubmit={submit}>
        <label>
          Operator call sign
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={28}
            minLength={2}
            required
            placeholder="e.g. Coast Runner"
            pattern="[A-Za-z0-9][A-Za-z0-9 ._\-]{1,27}"
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Opening station…' : 'Open station'}
        </button>
      </form>
      <button className="text-btn" onClick={signIn}>
        Sign in with a DeepSpace account
      </button>
    </Modal>
  )
}
