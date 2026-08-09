import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { Server } from 'socket.io'

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(async () => {
  const httpServer = createServer(async (req, res) => {
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

    const parsedUrl = parse(req.url, true)
    await handle(req, res, parsedUrl)
  })

  const io = new Server(httpServer, {
    cors: {
      origin: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      credentials: true
    }
  })

  const { setupSocketServer } = await import('./src/lib/socket/server.js')
  setupSocketServer(io)

  httpServer.listen(3000, () => {
    console.log('> KCA Platform ready on http://localhost:3000')
    console.log('> Socket.io server attached')
  })
})
