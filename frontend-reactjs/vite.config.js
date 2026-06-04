import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

const PYTHON = '/Users/alisartazkhan/miniconda3/envs/aligner/bin/python';
const DSP_SCRIPT = path.resolve(__dirname, 'dsp_server.py');

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

      server.middlewares.use('/api/compute-dsp', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405; res.end('Method Not Allowed'); return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { wavFile, t0, t1, nMels = 128, nFft = 512, colormap = 'inferno', pw = 1400, ph = 400 } = JSON.parse(body);
            const safe = path.basename(wavFile);
            if (!/\.wav$/i.test(safe)) {
              res.statusCode = 400; res.end('Only .wav files allowed'); return;
            }
            const wavPath = path.resolve(__dirname, 'public', safe);
            execFile(PYTHON, [DSP_SCRIPT, wavPath, String(t0), String(t1), String(nMels), String(nFft), colormap, String(pw), String(ph)],
              { maxBuffer: 50 * 1024 * 1024 },
              (err, stdout, stderr) => {
                if (err) {
                  console.error('[dsp_server]', stderr);
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: String(err), stderr }));
                  return;
                }
                res.setHeader('Content-Type', 'application/json');
                res.end(stdout);
              }
            );
          } catch (e) {
            res.statusCode = 500; res.end(JSON.stringify({ error: String(e) }));
          }
        });
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
  server: {
    port: 5173,
    watch: {
      ignored: ['**/vite.config.js'],
      usePolling: false,
      stabilityThreshold: 500,
    },
  },
  configFileDependencies: [],
});
