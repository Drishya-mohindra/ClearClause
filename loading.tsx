import { LoadingState } from '@/components/ui/spinner';

export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <LoadingState label="Loading the workspace..." />
    </div>
  );
}
