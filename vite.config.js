import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { parseMedicineSearch } from './netlify/functions/parse-medicine-search.mjs'

// Emulate only this authenticated function locally; secrets stay in Node, never Vite client code.
function localAiFunction(env) {
  return {
    name: 'local-ai-function',
    configureServer(server) {
      server.middlewares.use('/.netlify/functions/parse-medicine-search', async (req, res) => {
        try {
          let raw = ''
          for await (const chunk of req) {
            raw += chunk.toString()
            if (Buffer.byteLength(raw) > 4096) { res.writeHead(413); res.end('Request too large'); return }
          }
          const request = new Request('http://localhost/.netlify/functions/parse-medicine-search', {
            method: req.method,
            headers: { 'Content-Type': req.headers['content-type'] || '', Authorization: req.headers.authorization || '' },
            ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: raw }),
          })
          const response = await parseMedicineSearch(request, env)
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
          res.end(await response.text())
        } catch { res.writeHead(500); res.end('Could not process AI search') }
      })
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), localAiFunction({ ...loadEnv(mode, process.cwd(), ''), ...process.env })],
}))
