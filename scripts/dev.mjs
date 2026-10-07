// Runs the API (with --watch) and the Vite dev server side by side.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'dev:api'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev:web'], { stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
for (const p of procs) p.on('exit', (code) => { stop(); process.exitCode = code ?? 0; });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
