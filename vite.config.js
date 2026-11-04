import { defineConfig, loadEnv } from 'vite';
import { handlers } from './lib/handlers.js';
import { auth } from './lib/auth.js';
import { defaults } from './lib/defaults.js';
import { LIMITS } from './lib/limits.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['OPENROUTER_', 'ADMIN_', 'BLOB_']);
  for (const [key, value] of Object.entries(env)) if (value) process.env[key] = value;
  return {
    plugins: [{
      name: 'local-api',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const path = req.url?.split('?')[0];
          const handler = path === '/api/models' ? handlers.models : path === '/api/benchmark' ? handlers.benchmark : path === '/api/auth' ? auth.handler : path === '/api/defaults' ? defaults.handler : path === '/api/upload' ? defaults.uploadHandler : null;
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
