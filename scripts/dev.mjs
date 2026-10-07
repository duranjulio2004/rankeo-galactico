// Runs the API (with --watch) and the Vite dev server side by side.
// Spawns node/vite directly, not via `npm run`: npm doesn't forward SIGTERM,
// so killing an npm wrapper would leave an orphaned server behind.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// `node --watch` doesn't exit when the server crashes (it waits for a file
// change), so a busy port would otherwise fail quietly. Check up front.
const port = Number(process.env.PORT ?? 3000);
const free = await new Promise((resolve) => {
  const probe = createServer()
    .once('error', () => resolve(false))
    .once('listening', () => probe.close(() => resolve(true)))
    .listen(port);
});
if (!free) {
  console.error(`[dev] Port ${port} is already in use, so the API can't start. Find it with: lsof -i :${port}`);
  process.exit(1);
}

const procs = {
  api: spawn(process.execPath, ['--watch', '--disable-warning=ExperimentalWarning', 'src/server/index.ts'], { stdio: 'inherit' }),
  web: spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
};

let stopping = false;
const stop = () => {
  stopping = true;
  for (const p of Object.values(procs)) if (p.exitCode === null) p.kill('SIGTERM');
};

for (const [name, p] of Object.entries(procs)) {
  p.on('exit', (code) => {
    if (!stopping) {
      console.error(`\n[dev] ${name} exited (code ${code}); stopping the other one too.`);
    }
    stop();
    process.exitCode = code ?? 0;
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
