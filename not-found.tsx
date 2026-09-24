import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-20 text-center">
      <h1 className="text-lg font-semibold text-foreground">Page not found</h1>
      <p className="mt-2 text-sm text-foreground-muted">
        That page does not exist. Everything lives on the main workspace.
      </p>
      <Button asChild className="mt-6">
        <Link href="/">Back to the workspace</Link>
      </Button>
    </main>
  );
}
