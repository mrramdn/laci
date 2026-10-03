// Compare native and v1 CLI scans on identical disposable demo data.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binary = path.resolve(process.argv[2] ?? 'target/release/laci');
const legacy = process.argv[3] && path.resolve(process.argv[3]);
const timeBinary = process.env.LACI_TIME || '/usr/bin/time';
const home = mkdtempSync(path.join(tmpdir(), 'laci-benchmark-'));
function run(command, args, env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return result;
}
function measure(command, args, env) {
  const result = run(timeBinary, ['-f', 'LACI_MEASURE %e %M', command, ...args], env);
  const [, seconds, kib] = result.stderr.match(/LACI_MEASURE ([\d.]+) (\d+)/) ?? [];
  if (!kib) throw new Error('Could not read /usr/bin/time measurements');
  const snapshot = JSON.parse(result.stdout);
  return {
    wallMs: Math.round(Number(seconds) * 1000),
    scanMs: snapshot.tookMs,
    peakMiB: Math.round(Number(kib) / 1024 * 10) / 10,
    projects: Object.values(snapshot.nodes).filter(node => node.kind === 'project').length,
  };
}
try {
  run(process.execPath, [path.join(root, 'scripts/demo.ts'), home], process.env);
  mkdirSync(path.join(home, '.config/laci'), { recursive: true });
  writeFileSync(path.join(home, '.config/laci/config.json'), JSON.stringify({ roots: ['~/project'] }));
  const versions = [['native', binary, ['json'], { ...process.env, LACI_HOME: home }]];
  if (legacy) versions.push(['v1', process.execPath, ['--input-type=module', '-e',
    `const {scan}=await import(${JSON.stringify(pathToFileURL(path.join(legacy,'src/core/scan.ts')).href)}); console.log(JSON.stringify(await scan()));`], {
    ...process.env, HOME: home, XDG_CONFIG_HOME: '', XDG_CACHE_HOME: '',
  }]);
  const report = {};
  for (const [name, command, args, env] of versions) {
    rmSync(path.join(home, '.cache'), { recursive: true, force: true });
    const cold = measure(command, args, env);
    const warm = Array.from({ length: 3 }, () => measure(command, args, env));
    report[name] = { cold, warm };
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(home, { recursive: true, force: true });
}
