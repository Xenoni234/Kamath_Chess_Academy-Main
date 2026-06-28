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
