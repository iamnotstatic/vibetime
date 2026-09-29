// The leaderboard and the profile page both answer "this week" and "this
// month" about the same rows. Two public pages that disagree on where the week
// starts is worse than either being wrong on its own, so the boundary is
// defined once here and imported by both.

export function startOfCalendarMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function startOfCalendarWeek(): Date {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0 offset
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
}

// Ship events are keyed by UTC day and the calendar windows start at UTC
// midnight, so a plain day-string comparison matches them exactly.
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
