// Edge middleware: markdown content negotiation (acceptmarkdown).
// Agents sending `Accept: text/markdown` on a page route get the .md twin
// served from the same URL. Everyone else gets the app untouched.
// Scoped matcher = zero middleware work on any other path.
import { rewrite } from '@vercel/edge';

export const MD_TWINS: Record<string, string> = {
  '/': '/index.md',
  '/privacy': '/privacy.md',
  '/about': '/about.md',
  '/contact': '/contact.md',
};

export const config = { matcher: ['/', '/privacy', '/about', '/contact'] };

export default function middleware(req: Request): Response | undefined {
  const accept = req.headers.get('accept') ?? '';
  if (!accept.includes('text/markdown')) return undefined;
  const md = MD_TWINS[new URL(req.url).pathname];
  return md ? rewrite(md) : undefined;
}
