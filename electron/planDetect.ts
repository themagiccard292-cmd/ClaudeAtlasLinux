import type { Plan } from '../shared/types';

interface OrgLike {
  name?: string;
  capabilities?: string[];
  rate_limit_tier?: string;
  billing_type?: string;
}

/** Best-effort plan detection from claude.ai's /api/organizations payload (shape may drift). */
export function planFromOrgs(orgs: unknown): { plan: Plan; orgName?: string } {
  if (!Array.isArray(orgs) || orgs.length === 0) return { plan: 'unknown' };
  const rank: Record<Plan, number> = { unknown: 0, free: 1, pro: 2, max: 3, team: 4, enterprise: 5 };
  let best: { plan: Plan; orgName?: string } = { plan: 'unknown' };
  for (const raw of orgs as OrgLike[]) {
    const blob = [...(raw.capabilities ?? []), raw.rate_limit_tier ?? '', raw.billing_type ?? ''].join(' ').toLowerCase();
    let plan: Plan = 'free';
    if (/enterprise/.test(blob)) plan = 'enterprise';
    else if (/\braven\b|\bteam\b/.test(blob)) plan = 'team';
    else if (/claude_max|\bmax\b|max_\d/.test(blob)) plan = 'max';
    else if (/claude_pro|\bpro\b/.test(blob)) plan = 'pro';
    if (rank[plan] > rank[best.plan]) best = { plan, orgName: raw.name };
  }
  return best;
}
