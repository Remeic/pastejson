// Generate big JSON payloads for manual testing.
// Run: bun scripts/gen-big.ts [targetMB] [outPath]
// Also emits diff-a.json / diff-b.json (B = mutated A) next to the output
// for diff-view testing.
import { writeFileSync } from 'node:fs';

const targetMB = Number(process.argv[2] ?? 50);
const out = process.argv[3] ?? `/tmp/pastejson-big-${targetMB}mb.json`;

const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');

function str(i: number): string {
  return `${WORDS[i % WORDS.length]}-${(i * 7919) % 99991}`;
}

// some strings carry escapes / unicode / long runs to stress escLen + tokenizer
const DIRTY = [
  'quote"inside and \\ backslash',
  'line\nbreak\ttab\u0000ctrl',
  'emoji 😀 pair 👍🏽 lone\u0301 accent',
  'x'.repeat(400),
  '__proto__ constructor length',
];

function record(i: number): Record<string, unknown> {
  return {
    id: i,
    guid: `g-${i}-${(i * 7919) % 99991}`,
    active: i % 2 === 0,
    score: Math.round(Math.sin(i) * 100000) / 100,
    ratio: (i % 1000) / 7,
    tags: [str(i), str(i * 3), 'common', str(i * 7)],
    meta: {
      lat: 45.4 + i / 100000,
      lng: 9.19 + i / 100000,
      city: str(i * 11),
      zip: (i * 13) % 99999,
      flag: i % 3 === 0 ? null : true,
    },
    note: i % 11 === 0 ? DIRTY[i % DIRTY.length] : null,
    history: Array.from({ length: 2 + (i % 5) }, (_, k) => ({
      ts: 1700000000 + i * 60 + k,
      ev: str(i + k),
      ok: (i + k) % 4 !== 0,
    })),
  };
}

// size probe: binary-search row count hitting ~targetMB (minified)
let lo = 1000;
let hi = 5_000_000;
for (let it = 0; it < 22; it++) {
  const mid = (lo + hi) >> 1;
  const rows: unknown[] = [];
  // sample 2000 rows and extrapolate
  for (let i = 0; i < 2000; i++) rows.push(record(mid * 2000 + i));
  const approx = (JSON.stringify(rows).length / 2000) * mid;
  if (approx < targetMB * 1024 * 1024) lo = mid;
  else hi = mid;
}

console.log(`generating ${lo.toLocaleString('en-US')} rows → ${out}`);
const big = { name: 'pastejson-big', generated: new Date().toISOString(), count: lo, items: Array.from({ length: lo }, (_, i) => record(i)) };
const json = JSON.stringify(big);
writeFileSync(out, json);
console.log(`${out}: ${(json.length / 1048576).toFixed(1)} MB minified`);

// diff pair: ~2% of B mutated (values shifted, some keys dropped/added, array trimmed)
const aRows = (big.items as Record<string, unknown>[]).slice(0, Math.min(lo, 20000));
const bRows = structuredClone(aRows);
for (let i = 0; i < bRows.length; i++) {
  if (i % 50 === 0) (bRows[i] as Record<string, unknown>).score = ((i * 37) % 100000) / 100;
  if (i % 97 === 0) delete (bRows[i] as Record<string, unknown>).note;
  if (i % 89 === 0) (bRows[i] as Record<string, unknown>).fresh = { added: true, at: i };
  if (i % 73 === 0) ((bRows[i] as Record<string, unknown>).history as unknown[]).pop();
}
const aJson = JSON.stringify({ name: 'diff-a', count: aRows.length, items: aRows }, null, 2);
const bJson = JSON.stringify({ name: 'diff-b', count: bRows.length, items: bRows }, null, 2);
const dir = out.replace(/[^/]+$/, '');
writeFileSync(`${dir}diff-a.json`, aJson);
writeFileSync(`${dir}diff-b.json`, bJson);
console.log(`${dir}diff-a.json: ${(aJson.length / 1048576).toFixed(1)} MB`);
console.log(`${dir}diff-b.json: ${(bJson.length / 1048576).toFixed(1)} MB (mutated copy of A)`);
