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
    },
  };
}

export default defineConfig({
  plugins: [react(), publicFilesPlugin()],
  server: { port: 5173 },
});
