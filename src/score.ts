export type MomentumTier = 'shipped' | 'progressed' | 'tinkering' | 'exploring' | 'idle' | 'interrupted';

export interface Scoreable {
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  filesTouched: number;
  exitCode: number;
}

export interface Thresholds {
  thresholdLines: number;
  thresholdFiles: number;
}

export function scoreSession(session: Scoreable, thresholds: Thresholds): MomentumTier {
  if (session.exitCode > 0) return 'interrupted';

  const hasCommit = session.commits > 0;
  const linesNet = session.linesAdded + session.linesRemoved;
  const meaningful = linesNet > thresholds.thresholdLines || session.filesTouched > thresholds.thresholdFiles;

  if (hasCommit && meaningful) return 'shipped';
  if (hasCommit && !meaningful) return 'progressed';
  if (!hasCommit && meaningful) return 'tinkering';
  if (!hasCommit && linesNet > 0) return 'exploring';
  return 'idle';
}

export const TIER_FILLED: Record<MomentumTier, number> = {
  shipped: 8,
  progressed: 6,
  tinkering: 4,
  exploring: 2,
  idle: 0,
  interrupted: 0,
};
