import { defineConfig, loadEnv } from 'vite';
import { handlers } from './lib/handlers.js';
import { LIMITS } from './lib/limits.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'OPENROUTER_');
  if (env.OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
  return {
    plugins: [{
      name: 'local-api',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const path = req.url?.split('?')[0];
          const handler = path === '/api/models' ? handlers.models : path === '/api/benchmark' ? handlers.benchmark : null;
          if (!handler) return next();
          res.status = code => { res.statusCode = code; return res; };
          res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
          if (req.method === 'POST') {
            let size = 0; const chunks = [];
            for await (const chunk of req) {
              size += chunk.length;
              if (size > LIMITS.requestBytes) return res.status(413).json({ error: 'Request is too large (maximum 256 KB).' });
              chunks.push(chunk);
            }
            req.body = Buffer.concat(chunks).toString('utf8');
          }
          await handler(req, res);
        });
      },
    }],
  };
});
