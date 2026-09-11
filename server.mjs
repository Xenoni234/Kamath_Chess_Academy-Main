import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { Server } from 'socket.io'

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(async () => {
  const httpServer = createServer(async (req, res) => {
    const parsedUrl = parse(req.url, true)
    const pathname = parsedUrl.pathname || ''

    // The live class room (Phase 6) embeds a cross-origin video iframe (Jitsi),
    // which COEP require-corp would block. That page has no Stockfish, so it does
    // not need cross-origin isolation — skip the headers for its document so the
    // iframe loads. Reach it via a full navigation (a plain <a>, not client-side
    // routing) so the document actually loads without isolation.
    const isClassRoom = pathname.startsWith('/dashboard/classes/') && pathname.endsWith('/room')

    if (!isClassRoom) {
      // Cross-origin isolation. The multi-threaded Stockfish build in
      // public/engine/ needs SharedArrayBuffer, which browsers only expose to
      // cross-origin-isolated documents. Setting these here rather than in
      // next.config.ts covers Next pages, /public assets and the Socket.io
      // endpoint in one place.
      //
      // COEP blocks cross-origin subresources only; Socket.io connects to this
      // same origin, react-chessboard renders inline SVG pieces and next/font
      // self-hosts, so nothing in the app is affected. If isolation is ever
      // lost, src/lib/engine/select.ts falls back to the single-threaded build.
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    }

    await handle(req, res, parsedUrl)
  })

  // In production the origin must be explicit. Falling back to localhost would
  // silently allow credentialed sockets from a dev origin instead of the domain.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!dev && !appUrl) {
    throw new Error('NEXT_PUBLIC_APP_URL must be set in production (Socket.io CORS origin)')
  }

  const io = new Server(httpServer, {
    cors: {
      origin: appUrl || 'http://localhost:3000',
      credentials: true
    }
  })

  const { setupSocketServer } = await import('./src/lib/socket/server.js')
  setupSocketServer(io)

  // Hosts inject PORT and health-check it; a hardcoded 3000 fails those checks.
  const port = Number(process.env.PORT) || 3000

  httpServer.listen(port, () => {
    console.log(`> KCA Platform ready on http://localhost:${port}`)
    console.log('> Socket.io server attached')
  })
})

/**
 * Last line of defence.
 *
 * This one process serves the web app, the API and every socket. Node's default
 * action on an unhandled rejection is to terminate, so a single bad payload in an
 * async handler could take the entire academy offline. Log loudly and stay up —
 * the handlers themselves still validate and catch (see mediaHandlers).
 */
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason)
})

process.on('uncaughtException', (error) => {
  console.error('[server] uncaught exception:', error)
})
