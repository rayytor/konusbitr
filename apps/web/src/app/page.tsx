import { FileText, Lock, Quote, Server, TerminalSquare } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandIcon } from '@/components/brand-icon';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { currentSession } from '@/lib/auth/session';
import { APP_VERSION } from '@/lib/version';

/**
 * The front door.
 *
 * `design.md` §26: warm sepia, Instrument Serif display, strong whitespace,
 * minimal navigation, no gradients, no emoji, and a message about open-source,
 * private document intelligence. What it does *not* have is a marketing
 * illustration or a pile of feature cards — the page is the same reading
 * surface as the product, which is the most honest screenshot available.
 *
 * The citation sample below is static markup rather than a picture, so it is
 * selectable, translatable, readable by a screen reader, and correct in both
 * themes without anyone maintaining two PNGs.
 */
const POINTS = [
  {
    icon: Quote,
    title: 'Citations you can check',
    body: 'Every claim carries the page it came from, every quote is verified against that page before you see it, and clicking one highlights the exact region of the PDF.',
  },
  {
    icon: Server,
    title: 'Self-hosted, one command',
    body: 'Postgres, Redis, object storage, the web app and the document worker come up together. Your documents stay on your own infrastructure.',
  },
  {
    icon: Lock,
    title: 'Local models, offline',
    body: 'Point the chat, embedding and rerank roles at Ollama and turn offline mode on. Konusbitr refuses to start if anything would still reach a cloud provider.',
  },
  {
    icon: TerminalSquare,
    title: 'An API, not just an app',
    body: 'The same pipeline behind the interface is available over HTTP, with API keys scoped per organization.',
  },
];

export default async function HomePage() {
  const session = await currentSession();
  if (session) {
    redirect('/documents');
  }

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-5">
        <span className="flex items-center gap-2 font-serif text-[18px] leading-none">
          <BrandIcon className="size-4.5" />
          <span>Konusbitr</span>
        </span>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <a
            href="https://github.com/konusbitr/konusbitr"
            className="text-[15px] text-foreground-muted hover:text-foreground"
          >
            Source
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 pb-24">
        <section className="pt-16 sm:pt-24">
          <h1 className="max-w-3xl font-serif text-[44px] leading-[1.05] tracking-tight sm:text-[60px]">
            Read your documents with something that shows its work.
          </h1>
          <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-foreground-muted">
            Konusbitr is an open-source, self-hostable alternative to PDF.ai. Ask a question about a
            document and get an answer where every sentence points at the page it came from — and
            clicking that page reference highlights the exact passage.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link href="/signup">Create an account</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        </section>

        {/* A sample of the one interaction the product is built around. */}
        <section aria-label="What an answer looks like" className="mt-20 sm:mt-28">
          <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <figure className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-border-subtle bg-surface p-6">
              <figcaption className="flex items-center gap-2 text-[13px] text-foreground-subtle">
                <FileText aria-hidden className="size-3.5" />
                An answer
              </figcaption>
              <p className="text-[15px] leading-[1.7]">
                Operating expenses fell by 8.4% year over year, driven mostly by the consolidation
                of the two western distribution centres
                <span className="mx-0.5 inline-flex items-baseline rounded-[4px] border border-border bg-surface-muted px-1.5 py-px align-baseline text-[13px] tabular-nums text-accent-contrast">
                  p.&nbsp;42
                </span>
                . Headcount was unchanged over the same period
                <span className="mx-0.5 inline-flex items-baseline rounded-[4px] border border-border bg-surface-muted px-1.5 py-px align-baseline text-[13px] tabular-nums text-accent-contrast">
                  p.&nbsp;17
                </span>
                .
              </p>
            </figure>

            <figure className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-border-subtle bg-surface-sunken p-6">
              <figcaption className="text-[13px] text-foreground-subtle">
                The page it came from
              </figcaption>
              <div className="rounded-[var(--radius-sm)] bg-page p-5 shadow-[var(--page-shadow)]">
                <p className="font-serif text-[13px] leading-[1.9] text-[#29251f]">
                  <span className="text-[#70695d]">
                    Total operating expenses for the year were $412.6m.
                  </span>{' '}
                  <mark className="bg-highlight-active text-[#29251f] mix-blend-multiply">
                    Operating expenses fell by 8.4% year over year, driven mostly by the
                    consolidation of the two western distribution centres.
                  </mark>{' '}
                  <span className="text-[#70695d]">
                    Management expects the effect to persist into the next period.
                  </span>
                </p>
              </div>
            </figure>
          </div>
        </section>

        <section className="mt-20 grid gap-x-12 gap-y-10 sm:mt-28 sm:grid-cols-2">
          {POINTS.map((point) => {
            const Icon = point.icon;
            return (
              <div key={point.title} className="flex flex-col gap-2">
                <Icon aria-hidden className="size-4 text-foreground-subtle" />
                <h2 className="font-serif text-[18px] leading-tight">{point.title}</h2>
                <p className="max-w-prose text-[15px] leading-relaxed text-foreground-muted">
                  {point.body}
                </p>
              </div>
            );
          })}
        </section>

        <section className="mt-20 sm:mt-28">
          <h2 className="font-serif text-[24px] leading-tight">Run it yourself</h2>
          <p className="mt-2 max-w-prose text-[15px] leading-relaxed text-foreground-muted">
            Three commands, no API key required to start.
          </p>
          <pre className="mt-5 overflow-x-auto rounded-[var(--radius-md)] border border-border-subtle bg-surface p-4 font-mono text-[13px] leading-relaxed">
            <code>{`git clone https://github.com/konusbitr/konusbitr
cd konusbitr
cp .env.example .env && docker compose up`}</code>
          </pre>
        </section>
      </main>

      <footer className="mx-auto w-full max-w-5xl px-6 pb-10 text-[13px] text-foreground-subtle">
        Apache-2.0 · Konusbitr v{APP_VERSION}
      </footer>
    </div>
  );
}

export const dynamic = 'force-dynamic';
