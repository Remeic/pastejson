// Compare production builds through the clipboard, Worker, DOM, and Chrome Paint trace.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
const [beforeDir, afterDir, outputDir] = process.argv.slice(2);
if (!beforeDir || !afterDir || !outputDir) throw new Error('Usage: bun scripts/bench-browser-paste.mjs <before-dist> <after-dist> <output-dir>');
const task = resolve(outputDir);
mkdirSync(task, {recursive:true});
const roots = {before:resolve(beforeDir),after:resolve(afterDir)};
const htmlHash = (dir) => createHash('sha256').update(readFileSync(join(dir,'index.html'))).digest('hex');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === '/') return new Response(Bun.file(roots.after + '/index.html'), { headers: { 'Content-Type': 'text/html' } });
  if (u.pathname === '/before' || u.pathname === '/after') return new Response(Bun.file(roots[u.pathname.slice(1)] + '/index.html'), { headers: { 'Content-Type': 'text/html' } });
  return new Response(Bun.file(roots.after + u.pathname));
} });
const profile = mkdtempSync(join(tmpdir(), 'pj-ui-perf-'));
const child = Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--remote-debugging-port=0', '--window-size=1200,800', `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
const clients = [];
let browser;
function client(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id) { const p = pending.get(m.id); if (p) { clearTimeout(p.timer); pending.delete(m.id); p.resolve(m); } } else events.push(m); };
  const ready = new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error('CDP timeout: ' + method)); }, 20000);
    pending.set(next, { resolve, timer });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.error || r.result?.exceptionDetails) throw new Error(JSON.stringify(r)); return r.result.result.value; };
  const c = { ws, ready, send, evaluate, events }; clients.push(c); return c;
}
try {
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) { try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {} if (!port) await sleep(100); }
  if (!port) throw new Error('Chrome port unavailable');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  browser = client(version.webSocketDebuggerUrl); await browser.ready;
  const tabs = {};
  for (const side of ['before', 'after']) {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${server.url}${side}`, { method: 'PUT' })).json();
    const c = client(target.webSocketDebuggerUrl); await c.ready;
    await c.send('Runtime.enable'); await c.send('Page.enable'); await c.send('Network.setBypassServiceWorker', { bypass: true });
    await sleep(700);
    await c.evaluate(`(() => {
      const items = Array.from({length:17134}, (_,i)=>({id:i,guid:'g-'+i+'-'+(i*7919%99991),active:i%2===0,score:Math.round(Math.sin(i)*10000)/100,tags:['t'+i%13,'t'+i%7,'common'],nested:{lat:45.4+i/100000,lng:9.19+i/100000,city:'Milano'},note:i%11===0?'lorem ipsum dolor sit amet consectetur adipiscing elit':null}));
      const raw=JSON.stringify({name:'bench',count:items.length,items});
      const data=new DataTransfer();data.setData('text/plain',raw);
      globalThis.measurePaste = async (n) => {
        document.querySelector('#btn-new').click();
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const input=document.querySelector('#in');
        const start=performance.now();performance.mark('pj-start-'+n);
        const ready=new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('Rows timeout')),10000);
          const ob=new MutationObserver(()=>{
            if(document.body.dataset.mode==='loaded' && document.querySelector('#view .row')){
              ob.disconnect();clearTimeout(timer);performance.mark('pj-rows-'+n);
              const domMs=performance.now()-start;
              requestAnimationFrame(()=>setTimeout(()=>resolve({domMs,frameMs:performance.now()-start,status:document.querySelector('#statusbar').textContent,rows:document.querySelectorAll('#view .row').length}),0));
            }
          });ob.observe(document.querySelector('#view'),{childList:true,subtree:true});
        });
        input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
        return ready;
      };return raw.length;
    })()`);
    tabs[side] = c;
  }
  for (let i=0;i<3;i++) for (const side of ['before','after']) { await tabs[side].send('Page.bringToFront'); await tabs[side].evaluate(`measurePaste('warm-${side}-${i}')`); }
  await browser.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing', transferMode: 'ReturnAsStream' });
  const samples = { before: [], after: [] };
  for (let i=0;i<11;i++) for (const side of i%2?['after','before']:['before','after']) {
    await tabs[side].send('Page.bringToFront');
    samples[side].push({ name: `${side}-${i}`, ...await tabs[side].evaluate(`measurePaste('${side}-${i}')`) });
  }
  await browser.send('Tracing.end');
  for (let i=0;i<100 && !browser.events.some(e=>e.method==='Tracing.tracingComplete');i++) await sleep(50);
  const completed = browser.events.find(e=>e.method==='Tracing.tracingComplete');
  if (!completed) throw new Error('No trace');
  let trace='';for (;;) {const r=await browser.send('IO.read',{handle:completed.params.stream});trace+=r.result.data;if(r.result.eof)break;}
  await browser.send('IO.close',{handle:completed.params.stream});
  const events=JSON.parse(trace).traceEvents;
  for(const side of ['before','after'])for(const sample of samples[side]){
    const start=events.find(e=>e.name==='pj-start-'+sample.name);
    const ready=events.find(e=>e.name==='pj-rows-'+sample.name);
    const paint=ready&&events.filter(e=>e.name==='Paint'&&e.pid===ready.pid&&e.ts>=ready.ts).sort((a,b)=>a.ts-b.ts)[0];
    if(!start||!paint)throw new Error('Missing paint trace for '+sample.name);
    sample.firstPaintMs=(paint.ts+(paint.dur??0)-start.ts)/1000;
  }
  const median = (xs)=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
  const summary={};for(const side of ['before','after'])summary[side]={domMs:median(samples[side].map(s=>s.domMs)),frameMs:median(samples[side].map(s=>s.frameMs)),firstPaintMs:median(samples[side].map(s=>s.firstPaintMs).filter(x=>x!==null))};
  const screenshot=await tabs.after.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(task,'after-ui.png'),Buffer.from(screenshot.result.data,'base64'));
  const exceptions=clients.flatMap(c=>c.events.filter(e=>e.method==='Runtime.exceptionThrown'));
  const out={beforeHtmlSha256:htmlHash(roots.before),afterHtmlSha256:htmlHash(roots.after),measuredAt:new Date().toISOString(),browser:version.Browser,warmup:3,samples:11,statistic:'median',order:'alternating AB/BA',metric:'first main-thread Paint event after formatted rows were inserted',summary,measurements:samples,exceptions};
  writeFileSync(join(task,'ui-perf.json'),JSON.stringify(out,null,2)+'\n');
  console.log(JSON.stringify(out.summary));console.log('Browser exceptions: '+exceptions.length);
  if(exceptions.length)throw new Error('Browser exceptions were reported');
}finally{for(const c of clients)c.ws.close();child.kill();await child.exited;server.stop(true);rmSync(profile,{recursive:true,force:true});}

process.exit(0);
