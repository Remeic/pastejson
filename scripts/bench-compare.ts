// bun scripts/bench-compare.ts <base-ref> <bun|bun-isolated|chrome> <output.json> [odd-sample-count]
// Baseline source comes from git archive; the working tree stays unchanged.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { cpus, tmpdir, release } from 'node:os';
import { join, resolve } from 'node:path';

const [ref, engine, output, count = '41'] = process.argv.slice(2);
if (!ref || !output || !['bun', 'bun-isolated', 'chrome'].includes(engine)) {
  throw new Error('Usage: bun scripts/bench-compare.ts <base-ref> <bun|bun-isolated|chrome> <output.json> [odd-sample-count]');
}
const baseCommit = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
const temp = mkdtempSync(join(tmpdir(), 'pastejson-compare-'));
const root = process.cwd();
const sourceHash = createHash('sha256');
for (const name of readdirSync(join(root, 'src')).sort()) sourceHash.update(name).update(readFileSync(join(root, 'src', name)));
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isolatedComparison() {
  const entry = join(temp, 'single.ts');
  writeFileSync(entry, `import {measure} from ${JSON.stringify(join(root, 'scripts/perf-suite.ts'))};
import {pathToFileURL} from 'node:url';
const dir=process.argv[2];
const view=await import(pathToFileURL(dir+'/src/viewmodel.ts').href);
const render=await import(pathToFileURL(dir+'/src/render.ts').href);
const parse=await import(pathToFileURL(dir+'/src/parse.ts').href);
console.log(JSON.stringify(measure({...view,textHtml:render.textHtml,parseInput:parse.parseInput},${Number(count)})));`);
  const runs: [Record<string, unknown>[], Record<string, unknown>[]] = [[], []];
  for (let run = 0; run < 3; run++) {
    for (const side of run % 2 ? [1, 0] : [0, 1]) {
      const result: unknown = JSON.parse(execFileSync('bun', [entry, side === 0 ? temp : root], { encoding: 'utf8' }));
      if (!record(result) || !Array.isArray(result.metrics)) throw new Error('Invalid isolated benchmark result');
      runs[side].push(result);
    }
  }
  const metricAt = (run: Record<string, unknown>, index: number) => {
    if (!Array.isArray(run.metrics) || !record(run.metrics[index])) throw new Error('Invalid benchmark metric');
    return run.metrics[index];
  };
  const samplesAt = (run: Record<string, unknown>, index: number): number[] => {
    const samples = metricAt(run, index).samplesMs;
    if (!Array.isArray(samples) || !samples.every((n): n is number => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error('Invalid benchmark samples');
    }
    return samples;
  };
  const med = (times: number[]) => [...times].sort((a, b) => a - b)[times.length >> 1];
  if (!Array.isArray(runs[0][0].metrics)) throw new Error('No benchmark metrics');
  const metrics = runs[0][0].metrics.map((_, index) => {
    const before = runs[0].flatMap((run) => samplesAt(run, index));
    const after = runs[1].flatMap((run) => samplesAt(run, index));
    const beforeMs = med(before);
    const afterMs = med(after);
    const first = metricAt(runs[0][0], index);
    return { name: first.name, phase: first.phase, batch: first.batch, rawLength: first.rawLength,
      prettyLength: first.prettyLength, beforeMs, afterMs, gainPct: (1 - afterMs / beforeMs) * 100,
      buffers: [first.buffers, metricAt(runs[1][0], index).buffers], samplesMs: [before, after],
      processMediansMs: runs.map((side) => side.map((run) => med(samplesAt(run, index)))) };
  });
  return { warmup: runs[0][0].warmup, samplesPerProcess: Number(count), processRuns: 3,
    statistic: 'median of all samples', order: 'isolated processes, alternating AB/BA', metrics };
}

async function chromeComparison(): Promise<{ version: unknown; comparison: unknown }> {
  const entry = join(temp, 'probe.ts');
  const imports = (dir: string, name: string) => `import * as ${name}View from ${JSON.stringify(join(dir, 'src/viewmodel.ts'))};\nimport {textHtml as ${name}Paint} from ${JSON.stringify(join(dir, 'src/render.ts'))};\nimport {parseInput as ${name}Parse} from ${JSON.stringify(join(dir, 'src/parse.ts'))};\nconst ${name}={...${name}View,textHtml:${name}Paint,parseInput:${name}Parse};`;
  writeFileSync(entry, `import {compare} from ${JSON.stringify(join(root, 'scripts/perf-suite.ts'))};\n${imports(temp, 'before')}\n${imports(root, 'after')}\nglobalThis.perfCompare=()=>compare(before,after,${Number(count)});`);
  const bundle = join(temp, 'probe.js');
  execFileSync('bun', ['build', entry, '--target=browser', '--minify', '--outfile', bundle], { stdio: 'pipe' });
  const script = readFileSync(bundle);
  const server = createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Content-Type', req.url === '/probe.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/probe.js' ? script : '<script type="module" src="/probe.js"></script>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP server unavailable');
  const profile = join(temp, 'chrome-profile');
  const child = spawn(process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let ws: WebSocket | undefined;
  try {
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { /* Chrome is starting. */ }
      if (!port) await delay(100);
    }
    if (!port) throw new Error('Chrome debugging port unavailable');
    const tab: unknown = await (await fetch(`http://127.0.0.1:${port}/json/new?http://127.0.0.1:${address.port}/`, { method: 'PUT' })).json();
    if (!record(tab) || typeof tab.webSocketDebuggerUrl !== 'string') throw new Error('Chrome tab unavailable');
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    const socket = ws;
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    let id = 0;
    socket.onmessage = (event) => {
      const message: unknown = JSON.parse(String(event.data));
      if (record(message) && typeof message.id === 'number') {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    };
    await new Promise<void>((done, fail) => { socket.onopen = () => done(); socket.onerror = () => fail(new Error('Chrome socket failed')); });
    const send = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((done, fail) => {
      const next = ++id;
      const timeout = setTimeout(() => { pending.delete(next); fail(new Error(`Chrome timeout: ${method}`)); }, 60000);
      pending.set(next, (message) => { clearTimeout(timeout); done(message); });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
    await send('Runtime.enable');
    await delay(600);
    const reply = await send('Runtime.evaluate', { expression: 'perfCompare()', returnByValue: true });
    if (!record(reply.result) || reply.result.exceptionDetails || !record(reply.result.result)) {
      throw new Error(`Browser benchmark failed: ${JSON.stringify(reply)}`);
    }
    const version: unknown = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    return { version: record(version) ? version.Browser : 'unknown', comparison: reply.result.result.value };
  } finally {
    ws?.close();
    child.kill();
    await new Promise<void>((done) => child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', () => done()));
    await new Promise<void>((done) => server.close(() => done()));
  }
}

try {
  execFileSync('tar', ['-x', '-C', temp], { input: execFileSync('git', ['archive', baseCommit, 'src']) });
  const measured = engine !== 'chrome'
    ? { version: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(),
      comparison: isolatedComparison() }
    : await chromeComparison();
  const result = { baseCommit, candidate: 'working tree', sourceSha256: sourceHash.digest('hex'),
    suiteSha256: createHash('sha256').update(readFileSync(join(root, 'scripts/perf-suite.ts'))).digest('hex'),
    measuredAt: new Date().toISOString(), engine, machine: cpus()[0].model, os: release(), ...measured };
  writeFileSync(resolve(output), JSON.stringify(result, null, 2) + '\n');
  if (record(measured.comparison) && Array.isArray(measured.comparison.metrics)) {
    for (const metric of measured.comparison.metrics) {
      if (record(metric) && typeof metric.beforeMs === 'number' && typeof metric.afterMs === 'number' && typeof metric.gainPct === 'number') {
        console.log(`${metric.name} ${metric.phase}: ${metric.beforeMs.toFixed(6)} -> ${metric.afterMs.toFixed(6)} ms (${metric.gainPct.toFixed(1)}%)`);
      }
    }
  }
  console.log(`Saved ${resolve(output)}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
