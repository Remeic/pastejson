import type { buildView, buildMinTokens, ViewModel } from '../src/viewmodel';
import type { textHtml } from '../src/render';
import type { parseInput } from '../src/parse';

export interface PerfApi {
  buildView: typeof buildView;
  buildMinTokens: typeof buildMinTokens;
  textHtml: typeof textHtml;
  parseInput: typeof parseInput;
}

// Same record count and fields as the repository's 5 MiB gate.
function cases() {
  const items = Array.from({ length: 17134 }, (_, i) => ({
    id: i, guid: `g-${i}-${i * 7919 % 99991}`, active: i % 2 === 0,
    score: Math.round(Math.sin(i) * 10000) / 100,
    tags: [`t${i % 13}`, `t${i % 7}`, 'common'],
    nested: { lat: 45.4 + i / 100000, lng: 9.19 + i / 100000, city: 'Milano' },
    note: i % 11 === 0 ? 'lorem ipsum dolor sit amet consectetur adipiscing elit' : null,
  }));
  return [
    { name: 'mixed-5mb', value: { name: 'bench', count: items.length, items } },
    { name: 'integers-250k', value: Array.from({ length: 250000 }, (_, i) => i % 10) },
    { name: 'floats-100k', value: Array.from({ length: 100000 }, (_, i) => i / 7) },
    { name: 'strings-100k', value: Array.from({ length: 100000 }, (_, i) => `text-${i}`) },
    { name: 'escaped-50k', value: Array.from({ length: 50000 }, (_, i) => ({ 'quote"key': `x\n"\\${i}\ud800😀<&>`, '': i })) },
    { name: 'long-string-5mb', value: { data: 'x'.repeat(5 * 1024 * 1024) } },
    { name: 'unique-keys-50k', value: Object.fromEntries(Array.from({ length: 50000 }, (_, i) => [`key-${i}`, i])) },
    { name: 'root-string-5mb', value: 'x'.repeat(5 * 1024 * 1024) },
    { name: 'medium', value: items.slice(0, 32) },
    { name: 'dense-small', value: Array(1000).fill(0) },
    { name: 'small', value: { id: 12, a: [true, null, 'x'], msg: '<&>' } },
  ];
}

const WARMUP = 32;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];

// One implementation per process avoids cross-version JIT specialization.
export function measure(api: PerfApi, samples = 41) {
  if (!Number.isInteger(samples) || samples < 3 || samples % 2 === 0) {
    throw new Error('Sample count must be an odd integer >= 3');
  }
  let sink = 0;
  const metrics = [];
  for (const c of cases()) {
    const raw = JSON.stringify(c.value);
    const vm = api.buildView(c.value, 2, raw.length);
    const operations = {
      view: () => api.buildView(c.value, 2, raw.length).tokP.length,
      min: () => {
        const fresh: ViewModel = { ...vm, min: null, tokM: null };
        api.buildMinTokens(fresh);
        return fresh.tokM!.length;
      },
      paint: () => api.textHtml(vm, Math.max(0, (vm.lines >> 1) - 32), 64).length,
      paste: () => {
        const r = api.parseInput(raw);
        if (r.kind === 'error') throw new Error(r.message);
        return api.textHtml(api.buildView(r.value, 2, raw.length), 0, 64).length;
      },
    };
    for (const phase of ['view', 'min', 'paint', 'paste'] as const) {
      // Batch short inputs so browser timer resolution cannot dominate a sample.
      const batch = phase === 'paint' ? 100 : raw.length < 16384 ? 200 : 1;
      const sample = () => {
        const start = performance.now();
        for (let b = 0; b < batch; b++) sink ^= operations[phase]();
        return (performance.now() - start) / batch;
      };
      for (let i = 0; i < WARMUP; i++) sample();
      const times = Array.from({ length: samples }, sample);
      metrics.push({ name: c.name, phase, batch, medianMs: median(times), samplesMs: times,
        rawLength: raw.length, prettyLength: vm.pretty.length,
        buffers: { reserved: vm.tokP.buffer.byteLength + vm.lineStarts.buffer.byteLength,
          used: vm.tokP.byteLength + vm.lineStarts.byteLength } });
    }
  }
  return { warmup: WARMUP, samples, sink, metrics };
}

export function compare(before: PerfApi, after: PerfApi, samples = 41) {
  if (!Number.isInteger(samples) || samples < 3 || samples % 2 === 0) {
    throw new Error('Sample count must be an odd integer >= 3');
  }
  let sink = 0;
  const metrics = [];
  for (const c of cases()) {
    const raw = JSON.stringify(c.value);
    const vms = [before.buildView(c.value, 2, raw.length), after.buildView(c.value, 2, raw.length)];
    if (vms[0].pretty !== vms[1].pretty || vms[0].lines !== vms[1].lines) {
      throw new Error(`View contract changed: ${c.name}`);
    }
    const buffers = vms.map((vm) => ({
      reserved: vm.tokP.buffer.byteLength + vm.lineStarts.buffer.byteLength,
      used: vm.tokP.byteLength + vm.lineStarts.byteLength,
    }));
    // Separate call sites keep each measured API monomorphic, like the app.
    // A shared callback that dispatches both versions can change JIT behavior.
    const operations = {
      view: [() => before.buildView(c.value, 2, raw.length).tokP.length, () => after.buildView(c.value, 2, raw.length).tokP.length],
      min: [
        () => { const vm: ViewModel = { ...vms[0], min: null, tokM: null }; before.buildMinTokens(vm); return vm.tokM!.length; },
        () => { const vm: ViewModel = { ...vms[1], min: null, tokM: null }; after.buildMinTokens(vm); return vm.tokM!.length; },
      ],
      paint: [
        () => before.textHtml(vms[0], Math.max(0, (vms[0].lines >> 1) - 32), 64).length,
        () => after.textHtml(vms[1], Math.max(0, (vms[1].lines >> 1) - 32), 64).length,
      ],
      paste: [
        () => { const r = before.parseInput(raw); if (r.kind === 'error') throw new Error(r.message); return before.textHtml(before.buildView(r.value, 2, raw.length), 0, 64).length; },
        () => { const r = after.parseInput(raw); if (r.kind === 'error') throw new Error(r.message); return after.textHtml(after.buildView(r.value, 2, raw.length), 0, 64).length; },
      ],
    };
    for (const phase of ['view', 'min', 'paint', 'paste'] as const) {
      const batch = phase === 'paint' ? 100 : raw.length < 16384 ? 200 : 1;
      const fns = operations[phase];
      const measure = (side: number) => {
        const start = performance.now();
        for (let b = 0; b < batch; b++) sink ^= fns[side]();
        return (performance.now() - start) / batch;
      };
      for (let i = 0; i < WARMUP; i++) { measure(i % 2); measure(1 - i % 2); }
      const times: [number[], number[]] = [[], []];
      for (let i = 0; i < samples; i++) {
        for (const side of i % 2 ? [1, 0] : [0, 1]) times[side].push(measure(side));
      }
      const a = median(times[0]);
      const b = median(times[1]);
      metrics.push({
        name: c.name, phase, batch, beforeMs: a, afterMs: b,
        gainPct: (1 - b / a) * 100,
        wins: times[0].filter((t, i) => times[1][i] < t).length,
        rawLength: raw.length, prettyLength: vms[0].pretty.length,
        buffers, samplesMs: times,
      });
    }
  }
  return { warmup: WARMUP, samples, statistic: 'median', order: 'alternating AB/BA', sink, metrics };
}
