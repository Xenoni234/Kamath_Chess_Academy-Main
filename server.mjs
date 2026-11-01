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

    // Baseline security headers, on every response including the class room.
    //
    // Caddy does NOT add HSTS on its own — automatic HTTPS gets you the certificate and the
    // redirect, not the policy — so without this line a first visit over http:// is still
    // interceptable before the redirect lands. One year, subdomains included; deliberately no
    // `preload`, because that is a hard-to-reverse submission to a browser-vendor list.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    // Stops a browser second-guessing a Content-Type — the vector behind "upload a .txt that
    // runs as script". This app serves user-supplied PDFs and photos from its own origin.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // Full URLs stay on this origin. Dashboard paths carry student and game ids, and those
    // should not travel to Lichess or the AI provider in a Referer header.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    // Nothing here is meant to be framed by anyone else. Note this is about OUR pages being
    // embedded; the class room embedding Jitsi is the opposite direction and unaffected.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')

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

      // Deny the hardware this app never uses — but ONLY outside the class room, which is why
      // this sits inside the carve-out rather than beside the headers above.
      //
      // Permissions-Policy is not delegated to a CROSS-ORIGIN iframe by `camera=(self)`: self
      // means this origin, and the Jitsi frame is not this origin. So a global camera/microphone
      // denial would leave the video class rendering perfectly and simply never getting a
      // camera — exactly the kind of silent breakage that only shows up in a real lesson with a
      // real child waiting. The class-room document therefore gets no Permissions-Policy at all,
      // and the iframe's own `allow` attribute governs it.
      res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
      )
    }

    await handle(req, res, parsedUrl)
  })

  // In production the origin must be explicit. Falling back to localhost would
  // silently allow credentialed sockets from a dev origin instead of the domain.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!dev && !appUrl) {
    throw new Error('NEXT_PUBLIC_APP_URL must be set in production (Socket.io CORS origin)')
  }

  // Accept the apex AND the www host. Caddy serves both, so whichever one the
  // visitor happens to be on is the origin the browser will send. Naming only
  // one of them made every socket from the other host fail CORS — silently,
  // forever, because socket.io just keeps retrying.
  //
  // The client now connects same-origin, which makes CORS irrelevant for the
  // browser. This stays as the belt to that pair of braces: anything still
  // using an absolute URL, and any non-browser client, keeps working.
  const withWwwVariant = (url) => {
    try {
      const u = new URL(url)
      const host = u.host.startsWith('www.') ? u.host.slice(4) : `www.${u.host}`
      return [u.origin, `${u.protocol}//${host}`]
    } catch {
      return [url]
    }
  }
  const allowedOrigins = withWwwVariant(appUrl || 'http://localhost:3000')

  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
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
