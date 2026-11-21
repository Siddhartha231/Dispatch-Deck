import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DeepSpaceAuthProvider } from 'deepspace'
import { deck, message, type Identity } from './deck/api'
import { Home } from './deck/Home'
import RunPage from './deck/run/RunPage'
import './styles.css'
import './deck/deck.css'

const RUN_PATH = /^\/runs\/([a-f0-9-]{36})(\/report)?$/
const RETURN_PATH = /^\/(dashboard|runs\/[a-f0-9-]{36}(\/report)?)$/

/** DeepSpace sign-in lands on /home; send the operator back where they were. */
function returnAfterSignIn() {
  const back = sessionStorage.getItem('deck-return') ?? '/dashboard'
  sessionStorage.removeItem('deck-return')
  location.replace(RETURN_PATH.test(back) ? back : '/dashboard')
}

function App() {
  const [user, setUser] = useState<Identity | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    deck
      .me()
      .then(setUser)
      .catch((e) => setError(message(e)))
      .finally(() => setReady(true))
  }, [])

  const path = location.pathname.replace(/\/$/, '') || '/'
  const run = path.match(RUN_PATH)

  if (path === '/home') {
    returnAfterSignIn()
    return null
  }
  if (error)
    return (
      <main className="shell gate">
        <h1>Station unavailable</h1>
        <p role="alert">{error}</p>
        <button onClick={() => location.reload()}>Reconnect</button>
      </main>
    )
  if (run && !ready)
    return (
      <main className="shell gate" role="status">
        Connecting to the command room…
      </main>
    )
  if (run) return <RunPage id={run[1]} report={!!run[2]} user={user} setUser={setUser} />
  if (path !== '/' && path !== '/dashboard')
    return (
      <main className="shell gate">
        <h1>Operation not found</h1>
        <a href="/dashboard">Return to the operations desk</a>
      </main>
    )
  return <Home user={user} setUser={setUser} />
}

createRoot(document.getElementById('root')!).render(
  <DeepSpaceAuthProvider>
    <App />
  </DeepSpaceAuthProvider>,
)
