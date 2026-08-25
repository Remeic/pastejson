import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// strips comments + leading indentation from the emitted HTML — the
// singlefile output is the product, markup bytes count
const htmlMinify = () => ({
  name: 'html-min',
  transformIndexHtml: {
    order: 'post' as const,
    handler(html: string) {
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
