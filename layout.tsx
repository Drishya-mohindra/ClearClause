import type { Metadata, Viewport } from 'next';
import { Scale } from 'lucide-react';
import { DisclaimerBanner } from '@/components/features/disclaimer';
import { ThemeToggle } from '@/components/features/theme-toggle';
import { DISCLAIMER_SHORT } from '@/lib/disclaimer';
import './globals.css';

export const metadata: Metadata = {
  title: 'ClearClause - understand your legal documents',
  description:
    'Upload a contract and get a plain-language summary, flagged clauses, grounded answers with citations, and a checklist of what to do next. ' +
    DISCLAIMER_SHORT,
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Never block pinch-zoom: it is an accessibility requirement, not a nicety.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-background text-foreground">
        {/* First tab stop on every page: jump past the header to the content. */}
        <a href="#main" className="skip-link">
          Skip to main content
        </a>

        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-2.5">
              <Scale aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">ClearClause</p>
                <p className="truncate text-xs text-foreground-muted">
                  Understand what you are signing
                </p>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </header>

        <DisclaimerBanner />

        {children}

        <footer className="mt-10 border-t border-border bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-6 text-xs leading-relaxed text-foreground-muted sm:px-6">
            <p>
              ClearClause is an informational tool. It is not a law firm, it does not provide legal
              advice, and it will not tell you how the law applies where you live. Documents you add
              are held only for the length of your session and are never used for training.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
