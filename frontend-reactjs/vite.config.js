import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import fs from 'fs';
import path from 'path';

function publicFilesPlugin() {
  return {
    name: 'public-files-api',
    configureServer(server) {
      server.middlewares.use('/api/public-files', (req, res) => {
        const publicDir = path.resolve(__dirname, 'public');
        let files = [];
        try { files = fs.readdirSync(publicDir); } catch (_) {}
        const wavs = files.filter(f => /\.wav$/i.test(f));
        const tgs  = files.filter(f => /\.TextGrid$/i.test(f));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ wavs, tgs }));
      });

      server.middlewares.use('/api/save-textgrid', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405; res.end('Method Not Allowed'); return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { filename, content } = JSON.parse(body);
            // Safety: only allow writing .TextGrid files inside public/
            const safe = path.basename(filename);
            if (!/\.TextGrid$/i.test(safe)) {
              res.statusCode = 400; res.end('Only .TextGrid files allowed'); return;
            }
            const dest = path.resolve(__dirname, 'public', safe);
            fs.writeFileSync(dest, content, 'utf8');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, saved: safe }));
          } catch (e) {
            res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), publicFilesPlugin()],
  server: { port: 5173 },
});
