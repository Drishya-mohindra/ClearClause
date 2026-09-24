'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

/**
 * Last-resort boundary. Next.js has already stripped the message in
 * production, and nothing from the error object is rendered -- an error
 * raised while handling a document must not put document text on screen.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    // Intentionally no error detail: it may contain user content.
    // eslint-disable-next-line no-console
    console.error('[ui] An unexpected error occurred.');
  }, []);

  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-20">
      <Alert tone="error" title="Something went wrong">
        The page ran into an unexpected problem. Your documents are still loaded.
      </Alert>
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
