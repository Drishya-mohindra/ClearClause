import { Workspace } from '@/components/features/workspace';

/**
 * The app is a single workspace: documents on the left, the five things you
 * can do with them on the right. Keeping it on one screen means a reader never
 * loses sight of the document they are asking about.
 */
export default function HomePage() {
  return <Workspace />;
}
