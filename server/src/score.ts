export type MomentumTier = 'shipped' | 'progressed' | 'tinkering' | 'exploring' | 'idle';

export interface Stats {
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  filesTouched: number;
}

const THRESHOLD_LINES = 50;
const THRESHOLD_FILES = 3;

export function scoreSession(stats: Stats): MomentumTier {
  const hasCommit = stats.commits > 0;
  const linesNet = stats.linesAdded + stats.linesRemoved;
  const meaningful = linesNet > THRESHOLD_LINES || stats.filesTouched > THRESHOLD_FILES;

  if (hasCommit && meaningful) return 'shipped';
  if (hasCommit && !meaningful) return 'progressed';
  if (!hasCommit && meaningful) return 'tinkering';
  if (!hasCommit && linesNet > 0) return 'exploring';
  return 'idle';
}
