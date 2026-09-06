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

export interface ShipStats {
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  filesTouched: number;
}

export interface ShipEventState {
  shipEvents?: string[];
  eventBaseline?: ShipStats;
}

// A session can span days; ship events record which UTC days it actually
// shipped on, so a three-day session counts three times on the leaderboard
// instead of once on its end day. Bounded well past MAX_AGE_MS on the server.
const MAX_SHIP_EVENTS = 62;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Emit a ship event when the work done SINCE THE LAST EVENT would qualify as
// shipped on its own — cumulative stats always qualify once they ever did, so
// day two must earn its event with day two's commits. At most one event per
// UTC day per session. Pure: returns the fields to persist, or null when
// nothing changed. filesTouched is a set size, not additive, so its delta
// undercounts on later days; lines and commits carry the signal there.
export function trackShipEvents(prior: ShipEventState, stats: ShipStats, thresholds: Thresholds, nowMs: number): Required<ShipEventState> | null {
  const events = prior.shipEvents ?? [];
  const prev = prior.eventBaseline ?? { commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0 };

  // Stats can shrink (grace-window rescore, worktree dedupe, a moved repo);
  // a baseline above current stats would block every future event, so clamp
  // it down and persist the clamp.
  const base: ShipStats = {
    commits: Math.min(prev.commits, stats.commits),
    linesAdded: Math.min(prev.linesAdded, stats.linesAdded),
    linesRemoved: Math.min(prev.linesRemoved, stats.linesRemoved),
    filesTouched: Math.min(prev.filesTouched, stats.filesTouched),
  };
  const delta: Scoreable = {
    commits: stats.commits - base.commits,
    linesAdded: stats.linesAdded - base.linesAdded,
    linesRemoved: stats.linesRemoved - base.linesRemoved,
    filesTouched: stats.filesTouched - base.filesTouched,
    exitCode: 0,
  };

  const day = utcDay(nowMs);
  if (scoreSession(delta, thresholds) === 'shipped' && !events.includes(day) && events.length < MAX_SHIP_EVENTS) {
    return { shipEvents: [...events, day], eventBaseline: { ...stats } };
  }
  if (base.commits !== prev.commits || base.linesAdded !== prev.linesAdded || base.linesRemoved !== prev.linesRemoved || base.filesTouched !== prev.filesTouched) {
    return { shipEvents: events, eventBaseline: base };
  }
  return null;
}

export const TIER_FILLED: Record<MomentumTier, number> = {
  shipped: 8,
  progressed: 6,
  tinkering: 4,
  exploring: 2,
  idle: 0,
  interrupted: 0,
};
