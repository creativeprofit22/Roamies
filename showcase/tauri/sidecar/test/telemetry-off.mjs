// Runs the whole sidecar suite with ROAMIES_TELEMETRY=off (works under cmd.exe too). Run: npm run test:telemetry-off
import { spawnSync } from 'node:child_process';

const r = spawnSync('npm', ['test'], { stdio: 'inherit', shell: true, env: { ...process.env, ROAMIES_TELEMETRY: 'off' } });
process.exit(r.status ?? 1);
