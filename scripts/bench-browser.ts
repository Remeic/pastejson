import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { preview, type PreviewServer } from 'vite';
import {
  DEFAULT_BROWSER_THRESHOLDS,
  makeBrowserFixture,
  planBrowserSessions,
  readBrowserConfig,
  summarizeBrowserSamples,
  type BrowserSample,
} from './bench-browser-core';

const HOST = '127.0.0.1';
const PORT = 4173;
const FIXTURE_NAME = '__pastejson_bench_fixture.json';
const FIXTURE_PATH = resolve('dist', FIXTURE_NAME);

const CHROME_PATHS = process.platform === 'darwin'
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  : process.platform === 'win32'
    ? [
        `${process.env.PROGRAMFILES ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['PROGRAMFILES(X86)'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];

export interface NativeTiming {
  parseMs: number;
  stringifyMs: number;
  prettyLength: number;
}

interface AppTiming {
  firstPaintMs: number;
  longestTaskMs: number;
  longTasks: { startMs: number; durationMs: number }[];
  correct: boolean;
  actualFirstLines: string[];
  tokenClasses: string[];
  status: string;
}

interface RecordedSample extends BrowserSample {
  session: number;
  run: number;
  parseMs: number;
  stringifyMs: number;
  prettyLength: number;
  longTasks: { startMs: number; durationMs: number }[];
  status: string;
}

export function findChrome(env: Record<string, string | undefined>): string {
  const configured = env.PASTEJSON_CHROME_PATH;
  if (configured) {
    if (!existsSync(configured)) throw new Error(`Chrome not found at ${configured}`);
    return configured;
  }
  const found = CHROME_PATHS.find(existsSync);
  if (!found) {
    throw new Error(
      'Chrome Stable not found; set PASTEJSON_CHROME_PATH to its executable',
    );
  }
  return found;
}

export function processTreeRssBytes(rootPid: number): number | null {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
    const rows = output.trim().split('\n').map((line) => {
      const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
      return { pid, ppid, rss };
    });
    const descendants = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!descendants.has(row.ppid) || descendants.has(row.pid)) continue;
        descendants.add(row.pid);
        changed = true;
      }
    }
    return rows.reduce(
      (total, row) => total + (descendants.has(row.pid) ? row.rss * 1024 : 0),
      0,
    );
  } catch {
    return null;
  }
}

export async function startPreview(): Promise<PreviewServer> {
  return preview({
    preview: { host: HOST, port: PORT, strictPort: true },
    logLevel: 'silent',
  });
}

export async function launchChrome(executablePath: string): Promise<Browser> {
  return puppeteer.launch({
    executablePath,
    headless: true,
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    protocolTimeout: 180_000,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--enable-precise-memory-info',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  });
}

export async function measureNative(page: Page, fixtureUrl: string): Promise<NativeTiming> {
  return page.evaluate(async (url) => {
    const source = await (await fetch(url, { cache: 'no-store' })).text();
    const parseStart = performance.now();
    const value: unknown = JSON.parse(source);
    const parseMs = performance.now() - parseStart;
    const stringifyStart = performance.now();
    const pretty = JSON.stringify(value, null, 2);
    const stringifyMs = performance.now() - stringifyStart;
    return { parseMs, stringifyMs, prettyLength: pretty.length };
  }, fixtureUrl);
}

export const previewUrl = `http://${HOST}:${PORT}/`;

async function prepareAppPage(page: Page, fixtureUrl: string): Promise<void> {
  await page.goto(previewUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-mode="landing"]');
  await page.evaluate(async (url) => {
    const source = await (await fetch(url, { cache: 'no-store' })).text();
    (window as Window & { __pastejsonBenchRaw?: string }).__pastejsonBenchRaw = source;
  }, fixtureUrl);
  await page.evaluate(() => new Promise<void>((done) => {
    const idle = (window as Window & {
      requestIdleCallback?: (callback: () => void) => number;
    }).requestIdleCallback;
    if (idle) idle.call(window, () => { setTimeout(done, 50); });
    else setTimeout(done, 100);
  }));
}

async function measureApp(
  page: Page,
  expectedFirstLines: string[],
  expectedSize: string,
): Promise<AppTiming> {
  return page.evaluate((expectedLines, sizeText) => {
    const source = (window as Window & { __pastejsonBenchRaw?: string }).__pastejsonBenchRaw;
    if (!source) throw new Error('benchmark fixture was not loaded');

    return new Promise<AppTiming>((done, fail) => {
      const entries: { startTime: number; duration: number }[] = [];
      const longTaskObserver = PerformanceObserver.supportedEntryTypes.includes('longtask')
        ? new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              entries.push({ startTime: entry.startTime, duration: entry.duration });
          })
        : null;
      longTaskObserver?.observe({ type: 'longtask', buffered: true });

      const input = document.getElementById('in');
      if (!(input instanceof HTMLTextAreaElement)) {
        longTaskObserver?.disconnect();
        fail(new Error('paste input not found'));
        return;
      }

      let paintQueued = false;
      let settled = false;
      let timer = 0;
      const started = performance.now();
      const clean = (): void => {
        clearTimeout(timer);
        mutation.disconnect();
        longTaskObserver?.disconnect();
      };
      const reject = (message: string): void => {
        if (settled) return;
        settled = true;
        clean();
        fail(new Error(message));
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        const ended = performance.now();
        if (longTaskObserver) {
          for (const entry of longTaskObserver.takeRecords())
            entries.push({ startTime: entry.startTime, duration: entry.duration });
        }
        const rows = Array.from(document.querySelectorAll<HTMLElement>('#view .row code'));
        const actualFirstLines = rows.slice(0, expectedLines.length)
          .map((row) => row.textContent ?? '');
        const tokenClasses = Array.from(
          new Set(Array.from(document.querySelectorAll<HTMLElement>('#view .row code i'))
            .map((token) => token.className)),
        ).sort();
        const status = document.getElementById('statusbar')?.textContent ?? '';
        const textCorrect = expectedLines.every((line, i) => actualFirstLines[i] === line);
        const colorsCorrect = ['b', 'k', 'n', 's', 'x']
          .every((tokenClass) => tokenClasses.includes(tokenClass));
        const overlappingEntries = entries.filter((entry) =>
          entry.startTime + entry.duration >= started && entry.startTime <= ended,
        );
        clean();
        done({
          firstPaintMs: ended - started,
          longestTaskMs: overlappingEntries.reduce(
            (max, entry) => Math.max(max, entry.duration),
            0,
          ),
          longTasks: overlappingEntries.map((entry) => ({
            startMs: entry.startTime - started,
            durationMs: entry.duration,
          })),
          correct: textCorrect && colorsCorrect && status.includes(sizeText),
          actualFirstLines,
          tokenClasses,
          status,
        });
      };
      const check = (): void => {
        const mode = document.body.dataset.mode;
        if (mode === 'error') return reject('application rejected the benchmark fixture');
        const rows = document.querySelectorAll('#view .row code');
        if (mode !== 'loaded' || rows.length < expectedLines.length || paintQueued) return;
        paintQueued = true;
        requestAnimationFrame(() => { requestAnimationFrame(finish); });
      };
      const mutation = new MutationObserver(check);
      mutation.observe(document.body, { attributes: true, childList: true, subtree: true });
      timer = window.setTimeout(() => reject('paste-to-paint timed out after 60 seconds'), 60_000);

      const transfer = new DataTransfer();
      transfer.setData('text/plain', source);
      input.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }));
      check();
    });
  }, expectedFirstLines, expectedSize);
}

function fixed(value: number): string {
  return value.toFixed(1);
}

async function run(): Promise<void> {
  const config = readBrowserConfig(process.env);
  if (!existsSync(resolve('dist', 'index.html')))
    throw new Error('production build missing; run bun run build first');

  const fixture = makeBrowserFixture(config.bytes);
  const fixtureHash = createHash('sha256').update(fixture.raw).digest('hex');
  const fixtureMeta = {
    bytes: fixture.bytes,
    itemCount: fixture.itemCount,
    expectedFirstLines: fixture.expectedFirstLines,
  };
  writeFileSync(FIXTURE_PATH, fixture.raw);
  fixture.raw = '';

  const chromePath = findChrome(process.env);
  const sessionRuns = planBrowserSessions(config.runs, config.sessions);
  const samples: RecordedSample[] = [];
  let server: PreviewServer | null = null;
  let chromeVersion = '';

  console.log(
    `browser bench: ${(config.bytes / 1024 ** 2).toFixed(0)} MiB · ` +
    `${config.runs} runs / ${config.sessions} fresh Chrome sessions`,
  );
  console.log(`fixture sha256: ${fixtureHash}`);

  try {
    server = await startPreview();
    const fixtureUrl = new URL(FIXTURE_NAME, previewUrl).href;
    let runNumber = 0;
    for (let sessionIndex = 0; sessionIndex < sessionRuns.length; sessionIndex++) {
      const browser = await launchChrome(chromePath);
      try {
        chromeVersion ||= await browser.version();
        const browserPid = browser.process()?.pid ?? null;
        for (let inSession = 0; inSession < sessionRuns[sessionIndex]; inSession++) {
          runNumber++;
          const nativePage = await browser.newPage();
          await nativePage.goto(previewUrl, { waitUntil: 'domcontentloaded' });
          const native = await measureNative(nativePage, fixtureUrl);
          await nativePage.close();

          const appPage = await browser.newPage();
          await prepareAppPage(appPage, fixtureUrl);
          const beforeRss = browserPid === null ? null : processTreeRssBytes(browserPid);
          const app = await measureApp(
            appPage,
            fixtureMeta.expectedFirstLines,
            `${(fixtureMeta.bytes / 1024 ** 2).toFixed(1)} MB`,
          );
          const afterRss = browserPid === null ? null : processTreeRssBytes(browserPid);
          await appPage.close();

          const memoryDeltaBytes = beforeRss === null || afterRss === null
            ? null
            : Math.max(0, afterRss - beforeRss);
          const nativeMs = native.parseMs + native.stringifyMs;
          const sample: RecordedSample = {
            session: sessionIndex + 1,
            run: runNumber,
            parseMs: native.parseMs,
            stringifyMs: native.stringifyMs,
            prettyLength: native.prettyLength,
            longTasks: app.longTasks,
            firstPaintMs: app.firstPaintMs,
            nativeMs,
            longestTaskMs: app.longestTaskMs,
            memoryDeltaBytes,
            correct: app.correct,
            status: app.status,
          };
          samples.push(sample);
          console.log(
            `  ${String(runNumber).padStart(2)}  paint ${fixed(app.firstPaintMs)} ms · ` +
            `native ${fixed(nativeMs)} ms · ${fixed(app.firstPaintMs / nativeMs)}× · ` +
            `long ${fixed(app.longestTaskMs)} ms · ` +
            `rss ${memoryDeltaBytes === null ? 'n/a' : fixed(memoryDeltaBytes / 1024 ** 2) + ' MiB'} · ` +
            (app.correct ? 'correct' : 'INCORRECT'),
          );
          if (!app.correct) {
            console.error('expected:', fixtureMeta.expectedFirstLines);
            console.error('actual:', app.actualFirstLines);
            console.error('token classes:', app.tokenClasses);
            console.error('status:', app.status);
          }
        }
      } finally {
        await browser.close();
      }
    }

    const summary = summarizeBrowserSamples(samples, DEFAULT_BROWSER_THRESHOLDS);
    const result = {
      protocol: '100-1-2/v1',
      fixture: { ...fixtureMeta, sha256: fixtureHash },
      chromeVersion,
      hardware: {
        platform: `${process.platform} ${process.arch}`,
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        memoryBytes: totalmem(),
      },
      config,
      thresholds: DEFAULT_BROWSER_THRESHOLDS,
      samples,
      summary,
    };
    console.log('\n' + JSON.stringify(result, null, 2));
    console.log(`\n${summary.pass ? 'PASS' : 'FAIL'} 100–1–2`);
    if (!summary.pass) console.log(`failed: ${summary.failures.join(', ')}`);
    if (config.enforce && !summary.pass) process.exitCode = 1;
  } finally {
    if (server) await server.close();
    if (existsSync(FIXTURE_PATH)) unlinkSync(FIXTURE_PATH);
  }
}

await run();