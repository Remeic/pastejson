import { defineConfig, transformWithEsbuild } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// strips comments + leading indentation from the emitted HTML — the
// singlefile output is the product, markup bytes count
const htmlMinify = () => ({
  name: 'html-min',
  apply: 'build' as const,
  transformIndexHtml: {
    order: 'post' as const,
    async handler(html: string) {
      // The landing styles live in HTML. Minify them without changing their order.
      const boot = html.match(/<style id="boot">([\s\S]*?)<\/style>/);
      if (!boot) throw new Error('Expected the startup stylesheet');
      const css = await transformWithEsbuild(boot[1], 'boot.css', { loader: 'css', minify: true });
      html = html.replace(boot[0], '<style>' + css.code + '</style>');
      // Vite only minifies module scripts. Keep the early input capture small too.
      const startup = html.match(/<script id="startup">([\s\S]*?)<\/script>/);
      if (!startup) throw new Error('Expected the startup input capture');
      const min = await transformWithEsbuild(startup[1], 'startup.js', { target: 'es2022', minify: true });
      html = html.replace(startup[0], '<script>' + min.code + '</script>');
      // Paint the styled shell before the large inline module finishes downloading.
      const scripts = [...html.matchAll(/<script type="module"[^>]*>[\s\S]*?<\/script>/g)];
      if (scripts.length !== 1) throw new Error('Expected one inline application module');
      html = html.replace(scripts[0][0], '').replace('</body>', scripts[0][0] + '</body>');
      return html.replace(/<!--([\s\S]*?)-->/g, '').replace(/\n\s+/g, '\n');
    },
  },
});

export default defineConfig({
  plugins: [viteSingleFile(), htmlMinify()],
  build: {
    // es2022: native class fields — drops transpile helpers, evergreen targets only
    target: 'es2022',
    modulePreload: { polyfill: false }, // inlineDynamicImports → zero real preloads
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    reportCompressedSize: false,
  },
  worker: { format: 'es' }, // smaller blob (gzip −82B), module workers = evergreen
});
