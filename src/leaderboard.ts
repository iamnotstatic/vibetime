import { request } from './api.js';

export interface LeaderboardEntry {
  rank: number;
  handle: string;
  avatarUrl: string | null;
  shippedCount: number;
}

interface LeaderboardResponse {
  window: string;
  updatedAt: string;
  entries: LeaderboardEntry[];
}

export async function fetchLeaderboard(): Promise<LeaderboardResponse> {
  return request<LeaderboardResponse>('/leaderboard.json', { timeoutMs: 5000 });
}
