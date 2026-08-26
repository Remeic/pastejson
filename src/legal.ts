// legal island — lazy: loaded on first Privacy click. Self-contained by design
// (same philosophy as diff/search): no imports from hot files, no shared helpers,
// so it stays off the paste path. Static twin lives at public/privacy.html for
// crawlers and direct /privacy hits; this copy exists so opening it never exits
// the app (pasted doc survives).
let root: HTMLDivElement | null = null;

export let legalOpen = false;

const CONTENT = `
<h2>Privacy Policy</h2>
<p class="l-upd">Last updated: August 26, 2026</p>

<h3>Who we are</h3>
<p>json is a free online JSON formatter operated by Giulio Fagioli (<a href="https://justgiulio.dev" target="_blank" rel="noopener">justgiulio.dev</a>) as data controller under the EU General Data Protection Regulation (GDPR).</p>

<h3>What happens to your data</h3>
<p>Everything you paste, type or drop into this page is processed <strong>100% locally in your browser</strong>. Your JSON is never uploaded, transmitted, stored or logged by us. Closing the tab erases it.</p>

<h3>Data we do not collect</h3>
<ul>
<li>No cookies</li>
<li>No analytics or tracking scripts</li>
<li>No account, no forms, no identifiers</li>
<li>No third-party network requests while you use the tool</li>
</ul>

<h3>Hosting logs</h3>
<p>The site is hosted by Vercel Inc. As with any web server, Vercel may process standard request metadata (IP address, user agent, timestamp) in server logs for security and abuse prevention. This processing is based on legitimate interest (GDPR Art. 6(1)(f)). We do not access or use these logs for profiling. See Vercel's privacy documentation for retention details.</p>

<h3>Your rights (GDPR Art. 15–21)</h3>
<p>You have the right to access, rectify, erase, restrict, port and object to the processing of your personal data. Since we hold no personal data about you, most rights are satisfied trivially: there is nothing to disclose or delete. For questions or complaints about hosting logs, contact us; you also have the right to lodge a complaint with your national supervisory authority.</p>

<h3>Contact</h3>
<p>Giulio Fagioli — <a href="https://justgiulio.dev" target="_blank" rel="noopener">justgiulio.dev</a></p>

<h3>Changes</h3>
<p>If this policy changes, the updated date above will change with it.</p>
`;

export function openLegal(): void {
  if (!root) {
    root = document.createElement('div');
    root.id = 'legal';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Privacy Policy');
    root.innerHTML =
      '<div id="legal-card"><button id="btn-legal-close" title="Close (Esc)" aria-label="Close privacy policy">✕</button><div class="legal-body">' +
      CONTENT +
      '</div></div>';
    document.body.appendChild(root);
    root.querySelector('#btn-legal-close')!.addEventListener('click', closeLegal);
    // click outside card closes
    root.addEventListener('click', (e) => {
      if (e.target === root) closeLegal();
    });
  }
  root.hidden = false;
  legalOpen = true;
}

export function closeLegal(): void {
  if (!root || !legalOpen) return;
  root.hidden = true;
  legalOpen = false;
}
