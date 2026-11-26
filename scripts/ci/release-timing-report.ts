#!/usr/bin/env bun
/**
 * Release timing summary and regression reporter for release.yml.
 *
 * Computes elapsed durations for every step in the current release run,
 * compares against the latest prior successful release run when available,
 * and writes a slowest-steps Markdown table to GITHUB_STEP_SUMMARY.
 */
import { appendFileSync } from "node:fs";
import { runGh, runGhJson, type GhRunner } from "./release-guard";

export interface WorkflowStepTiming {
  name: string;
  started_at?: string;
  completed_at?: string;
}

export interface WorkflowJobTiming {
  name: string;
  started_at?: string;
  completed_at?: string;
  steps?: WorkflowStepTiming[];
}

export interface JobsPage {
  jobs?: WorkflowJobTiming[];
}

export interface StepDurationRow {
  key: string;
  job: string;
  step: string;
  seconds: number;
}

export interface StepRegressionRow extends StepDurationRow {
  baselineSeconds: number;
  percent: number;
}

export interface ReleaseTimingReport {
  currentWorkflowSeconds: number | null;
  baselineWorkflowSeconds: number | null;
  regressions: StepRegressionRow[];
  markdown: string;
}

function payloadJobs(payload: JobsPage | JobsPage[]): WorkflowJobTiming[] {
  const pages = Array.isArray(payload) ? payload : [payload];
  return pages.flatMap(page => (Array.isArray(page?.jobs) ? page.jobs : []));
}

function elapsedSeconds(startedAt?: string, completedAt?: string): number | null {
  const start = Date.parse(startedAt ?? "");
  const end = Date.parse(completedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function timingRows(payload: JobsPage | JobsPage[]): StepDurationRow[] {
  return payloadJobs(payload).flatMap(job =>
    (job.steps ?? []).flatMap(step => {
      const seconds = elapsedSeconds(step.started_at, step.completed_at);
      if (seconds === null) return [];
      return [{
        key: `${job.name} / ${step.name}`,
        job: job.name,
        step: step.name,
        seconds,
      }];
    }),
  );
}

function workflowSpanSeconds(payload: JobsPage | JobsPage[]): number | null {
  const jobs = payloadJobs(payload);
  const starts = jobs.map(job => Date.parse(job.started_at ?? "")).filter(Number.isFinite);
  const ends = jobs.map(job => Date.parse(job.completed_at ?? "")).filter(Number.isFinite);
  if (starts.length === 0 || ends.length === 0) return null;
  return Math.round((Math.max(...ends) - Math.min(...starts)) / 1000);
}

function percentDelta(current: number, baseline: number): number | null {
  if (!(baseline > 0)) return null;
  return Math.round(((current - baseline) / baseline) * 100);
}

export function buildReleaseTimingReport(
  currentPayload: JobsPage | JobsPage[],
  baselinePayload: JobsPage | JobsPage[] = [],
): ReleaseTimingReport {
  const currentRows = timingRows(currentPayload);
  const baselineByKey = new Map(timingRows(baselinePayload).map(row => [row.key, row]));

  const regressions: StepRegressionRow[] = [];
  for (const row of currentRows) {
    const baseline = baselineByKey.get(row.key);
    if (!baseline) continue;
    const percent = percentDelta(row.seconds, baseline.seconds);
    if (percent === null || percent <= 10 || row.seconds - baseline.seconds < 15) continue;
    regressions.push({ ...row, baselineSeconds: baseline.seconds, percent });
  }
  regressions.sort((a, b) => b.percent - a.percent || b.seconds - a.seconds);

  const currentWorkflowSeconds = workflowSpanSeconds(currentPayload);
  const baselineWorkflowSeconds = workflowSpanSeconds(baselinePayload);
  const slowest = [...currentRows].sort((a, b) => b.seconds - a.seconds).slice(0, 15);

  const markdown = [
    "## Release timing summary",
    "",
    `- Current workflow span: ${currentWorkflowSeconds ?? "n/a"}s`,
    `- Previous successful span: ${baselineWorkflowSeconds ?? "n/a"}s`,
    `- Step regressions (>10% and >=15s): ${regressions.length}`,
    "",
    "| Slowest step | Current | Previous | Change |",
    "| --- | ---: | ---: | ---: |",
    ...slowest.map(row => {
      const baseline = baselineByKey.get(row.key);
      const change = baseline ? percentDelta(row.seconds, baseline.seconds) : null;
      const sign = change !== null && change > 0 ? "+" : "";
      const changeText = change === null ? "n/a" : `${sign}${change}%`;
      const baselineText = baseline ? `${baseline.seconds}s` : "n/a";
      return `| ${row.key.replaceAll("|", "\\|")} | ${row.seconds}s | ${baselineText} | ${changeText} |`;
    }),
    "",
  ].join("\n");

  return { currentWorkflowSeconds, baselineWorkflowSeconds, regressions, markdown };
}

export function reportCurrentReleaseTiming(options: {
  repo?: string;
  runId?: string;
  workflow?: string;
  summaryPath?: string;
  gh?: GhRunner;
} = {}): void {
  const repo = options.repo ?? process.env.GITHUB_REPOSITORY;
  const runId = options.runId ?? process.env.GITHUB_RUN_ID;
  const workflow = options.workflow ?? "release.yml";
  const summaryPath = options.summaryPath ?? process.env.GITHUB_STEP_SUMMARY;
  const gh = options.gh ?? runGh;

  if (!repo || !runId) {
    console.log("Missing GITHUB_REPOSITORY or GITHUB_RUN_ID; skipping timing report.");
    return;
  }

  const currentPayload = runGhJson<JobsPage[]>(
    ["api", "--paginate", "--slurp", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`],
    gh,
  );
  let baselinePayload: JobsPage[] = [];
  try {
    const runsResp = runGhJson<{ workflow_runs?: Array<{ id?: number }> }>(
      ["api", `repos/${repo}/actions/workflows/${workflow}/runs?status=success&per_page=10`],
      gh,
    );
    const previous = (runsResp.workflow_runs ?? []).find(run => String(run.id ?? "") !== String(runId));
    if (previous?.id) {
      baselinePayload = runGhJson<JobsPage[]>(
        ["api", "--paginate", "--slurp", `repos/${repo}/actions/runs/${previous.id}/jobs?per_page=100`],
        gh,
      );
    }
  } catch (error) {
    console.warn(`[release-timing] baseline unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const report = buildReleaseTimingReport(currentPayload, baselinePayload);
  console.log(report.markdown);
  if (summaryPath) {
    appendFileSync(summaryPath, `${report.markdown}\n`);
  }
  for (const reg of report.regressions) {
    console.log(`::warning::Release step '${reg.key}' took ${reg.seconds}s vs ${reg.baselineSeconds}s (+${reg.percent}%)`);
  }
}

if (import.meta.main) {
  try {
    reportCurrentReleaseTiming();
  } catch (error) {
    console.warn(`[release-timing] non-fatal summary error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
