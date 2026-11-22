let mainAccountPlan: string | null = null;
let jwtPlanAttempted = false;

export function setMainAccountPlan(plan: string | null): void {
  mainAccountPlan = plan;
  if (plan === null) jwtPlanAttempted = false;
}

export function peekMainAccountPlan(): string | null {
  return mainAccountPlan;
}

export function isMainAccountJwtPlanAttempted(): boolean {
  return jwtPlanAttempted;
}

export function markMainAccountJwtPlanAttempted(): void {
  jwtPlanAttempted = true;
}
