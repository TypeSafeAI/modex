/** One model-usage row for Analytics, as recorded per turn by main and read by the dashboard. */
export interface UsageEvent {
  id: string;
  at: string;
  tool: string;
  model: string;
  session: string;
  project: string;
  account: string;
  kind: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  cost: number | null;
  uncachedCost: number | null;
}
