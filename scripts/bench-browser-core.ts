const MIB = 1024 * 1024;

const fixtureRows = Array.from({ length: 64 }, (_, i) => ({
  id: i,
  guid: `g-${i}-${(i * 7919) % 99991}`,
  active: i % 2 === 0,
  score: Math.round(Math.sin(i) * 10000) / 100,
  tags: [`t${i % 13}`, `t${i % 7}`, 'common'],
  nested: { lat: 45.4 + i / 100000, lng: 9.19 + i / 100000, city: 'Milano' },
  note: i % 11 === 0 ? null : 'lorem ipsum dolor sit amet',
}));

const rowJson = fixtureRows.map((row) => JSON.stringify(row));
const expectedFirstLines = JSON.stringify({ name: 'bench', items: [fixtureRows[0]] }, null, 2)
  .split('\n')
  .slice(0, 8);

export interface BrowserFixture {
  raw: string;
  bytes: number;
  itemCount: number;
  expectedFirstLines: string[];
}

export function makeBrowserFixture(targetBytes: number): BrowserFixture {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 1024)
    throw new RangeError('browser fixture must be an integer of at least 1024 bytes');

  const head = '{"name":"bench","items":[';
  const tailHead = '],"padding":"';
  const tail = '"}';
  let remaining = targetBytes - head.length - tailHead.length - tail.length;
  let body = '';
  let itemCount = 0;

  if (remaining >= rowJson[0].length) {
    body = rowJson[0];
    remaining -= rowJson[0].length;
    itemCount = 1;

    const cycle = rowJson.map((row) => ',' + row).join('');
    const cycles = Math.floor(remaining / cycle.length);
    if (cycles > 0) {
      body += cycle.repeat(cycles);
      remaining -= cycle.length * cycles;
      itemCount += rowJson.length * cycles;
    }

    for (const row of rowJson) {
      const part = ',' + row;
      if (part.length > remaining) break;
      body += part;
      remaining -= part.length;
      itemCount++;
    }
  }

  const raw = head + body + tailHead + 'x'.repeat(remaining) + tail;
  if (raw.length !== targetBytes) throw new Error('fixture size drift');
  return { raw, bytes: raw.length, itemCount, expectedFirstLines: [...expectedFirstLines] };
}

export function planBrowserSessions(totalRuns: number, sessions: number): number[] {
  if (!Number.isSafeInteger(totalRuns) || totalRuns < 1)
    throw new RangeError('browser benchmark needs at least one run');
  if (!Number.isSafeInteger(sessions) || sessions < 1 || sessions > totalRuns)
    throw new RangeError('sessions must be between one and total runs');
  const base = Math.floor(totalRuns / sessions);
  const extra = totalRuns % sessions;
  return Array.from({ length: sessions }, (_, i) => base + (i < extra ? 1 : 0));
}

export interface BrowserBenchConfig {
  bytes: number;
  runs: number;
  sessions: number;
  enforce: boolean;
}

function positiveEnvInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new RangeError(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} is too large`);
  return value;
}

export function readBrowserConfig(
  env: Record<string, string | undefined>,
): BrowserBenchConfig {
  const mib = positiveEnvInt(env, 'PASTEJSON_BENCH_MIB', DEFAULT_BROWSER_MIB);
  const runs = positiveEnvInt(env, 'PASTEJSON_BENCH_RUNS', 30);
  const sessions = positiveEnvInt(env, 'PASTEJSON_BENCH_SESSIONS', 5);
  const bytes = mib * MIB;
  if (!Number.isSafeInteger(bytes)) throw new RangeError('PASTEJSON_BENCH_MIB is too large');
  planBrowserSessions(runs, sessions);
  const enforceRaw = env.PASTEJSON_BENCH_ENFORCE;
  if (enforceRaw !== undefined && enforceRaw !== '0' && enforceRaw !== '1')
    throw new RangeError('PASTEJSON_BENCH_ENFORCE must be 0 or 1');
  return { bytes, runs, sessions, enforce: enforceRaw !== '0' };
}

export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) throw new RangeError('percentile needs at least one value');
  if (!(quantile > 0 && quantile <= 1)) throw new RangeError('quantile must be in (0, 1]');
  if (values.some((value) => !Number.isFinite(value)))
    throw new RangeError('percentile values must be finite');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}

export interface BrowserThresholds {
  maxFirstPaintP50Ms: number;
  maxFirstPaintP95Ms: number;
  maxRatioP95: number;
  maxLongTaskMs: number;
  maxMemoryDeltaBytes: number;
}

export const DEFAULT_BROWSER_THRESHOLDS: Readonly<BrowserThresholds> = Object.freeze({
  maxFirstPaintP50Ms: 750,
  maxFirstPaintP95Ms: 1000,
  maxRatioP95: 2,
  maxLongTaskMs: 50,
  maxMemoryDeltaBytes: 1.5 * 1024 ** 3,
});

export interface BrowserSample {
  firstPaintMs: number;
  nativeMs: number;
  longestTaskMs: number;
  memoryDeltaBytes: number | null;
  correct: boolean;
}

export interface BrowserSummary {
  firstPaintP50Ms: number;
  firstPaintP95Ms: number;
  ratioP95: number;
  longestTaskMs: number;
  maxMemoryDeltaBytes: number | null;
  allCorrect: boolean;
  pass: boolean;
  failures: string[];
}

export function summarizeBrowserSamples(
  samples: BrowserSample[],
  thresholds: Readonly<BrowserThresholds>,
): BrowserSummary {
  if (samples.length === 0) throw new RangeError('browser benchmark needs samples');
  for (const sample of samples) {
    if (!(sample.firstPaintMs >= 0) || !(sample.nativeMs > 0) || !(sample.longestTaskMs >= 0))
      throw new RangeError('browser sample timings must be finite and non-negative');
    if (![sample.firstPaintMs, sample.nativeMs, sample.longestTaskMs].every(Number.isFinite))
      throw new RangeError('browser sample timings must be finite and non-negative');
    if (sample.memoryDeltaBytes !== null &&
        (!Number.isFinite(sample.memoryDeltaBytes) || sample.memoryDeltaBytes < 0))
      throw new RangeError('browser sample memory must be null or non-negative');
  }

  const firstPaint = samples.map((sample) => sample.firstPaintMs);
  const ratios = samples.map((sample) => sample.firstPaintMs / sample.nativeMs);
  const firstPaintP50Ms = percentile(firstPaint, 0.5);
  const firstPaintP95Ms = percentile(firstPaint, 0.95);
  const ratioP95 = percentile(ratios, 0.95);
  const longestTaskMs = Math.max(...samples.map((sample) => sample.longestTaskMs));
  const memoryMeasured = samples.every((sample) => sample.memoryDeltaBytes !== null);
  const maxMemoryDeltaBytes = memoryMeasured
    ? Math.max(...samples.map((sample) => sample.memoryDeltaBytes as number))
    : null;
  const allCorrect = samples.every((sample) => sample.correct);
  const failures: string[] = [];
  if (firstPaintP50Ms > thresholds.maxFirstPaintP50Ms) failures.push('paint-p50');
  if (firstPaintP95Ms > thresholds.maxFirstPaintP95Ms) failures.push('paint-p95');
  if (ratioP95 > thresholds.maxRatioP95) failures.push('native-ratio');
  if (longestTaskMs > thresholds.maxLongTaskMs) failures.push('long-task');
  if (maxMemoryDeltaBytes === null) failures.push('memory-unavailable');
  else if (maxMemoryDeltaBytes > thresholds.maxMemoryDeltaBytes) failures.push('memory');
  if (!allCorrect) failures.push('correctness');

  return {
    firstPaintP50Ms,
    firstPaintP95Ms,
    ratioP95,
    longestTaskMs,
    maxMemoryDeltaBytes,
    allCorrect,
    pass: failures.length === 0,
    failures,
  };
}

export const DEFAULT_BROWSER_MIB = 100;
export const DEFAULT_BROWSER_BYTES = DEFAULT_BROWSER_MIB * MIB;