import Table from "cli-table3";
import chalk from "chalk";
import type {
  Application,
  Finding,
  Fix,
  FixProgress,
  QuotaBalance,
  QuotaCounter,
  ScanBatch,
  ScanProgress,
  ScanResults,
} from "../api/types.js";
import { isTty } from "./tty.js";

export function renderJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function printKv(pairs: Array<[string, string | number | null | undefined]>): void {
  const width = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    const key = chalk.dim(k.padEnd(width, " "));
    const val = v === null || v === undefined ? chalk.dim("—") : String(v);
    process.stdout.write(`${key}  ${val}\n`);
  }
}

export function renderApplicationsTable(apps: readonly Application[]): void {
  if (apps.length === 0) {
    process.stdout.write(chalk.dim("No applications.\n"));
    return;
  }
  const table = new Table({
    head: ["ID", "Name", "Repositories", "Archived", "Updated"],
    style: { head: ["cyan"] },
  });
  for (const a of apps) {
    table.push([
      a.id,
      a.name,
      String(a.repositories?.length ?? 0),
      a.archived ? "yes" : "no",
      fmtDate(a.updated_at),
    ]);
  }
  process.stdout.write(table.toString() + "\n");
}

export function renderApplication(app: Application): void {
  printKv([
    ["ID", app.id],
    ["Name", app.name],
    ["Description", app.description ?? null],
    ["Archived", app.archived ? "yes" : "no"],
    ["Created", fmtDate(app.created_at)],
    ["Updated", fmtDate(app.updated_at)],
  ]);
  if (app.repositories && app.repositories.length > 0) {
    process.stdout.write(chalk.dim("\nRepositories:\n"));
    const table = new Table({
      head: ["Full name", "Default branch", "Provider"],
      style: { head: ["cyan"] },
    });
    for (const r of app.repositories) {
      table.push([r.full_name, r.default_branch, r.provider]);
    }
    process.stdout.write(table.toString() + "\n");
  }
}

export function renderScanBatchesTable(batches: readonly ScanBatch[]): void {
  if (batches.length === 0) {
    process.stdout.write(chalk.dim("No scans.\n"));
    return;
  }
  const table = new Table({
    head: ["Batch ID", "Type", "Status", "Repos", "Completed", "Created"],
    style: { head: ["cyan"] },
  });
  for (const b of batches) {
    table.push([
      b.batch_id,
      b.scan_type,
      colorStatus(b.status),
      `${b.scans_completed}/${b.total_repositories}`,
      b.completed_at ? fmtDate(b.completed_at) : chalk.dim("—"),
      fmtDate(b.created_at),
    ]);
  }
  process.stdout.write(table.toString() + "\n");
}

export function renderScanBatch(batch: ScanBatch): void {
  printKv([
    ["Batch ID", batch.batch_id],
    ["Application ID", batch.application_id],
    ["Type", batch.scan_type],
    ["Status", batch.status],
    ["Total repositories", batch.total_repositories],
    ["Created", batch.scans_created],
    ["Failed", batch.scans_failed],
    ["Completed", batch.scans_completed],
    ["Assessed", batch.scans_assessed],
    ["Started", batch.started_at ? fmtDate(batch.started_at) : null],
    ["Completed at", batch.completed_at ? fmtDate(batch.completed_at) : null],
    ["Error", batch.error_message ?? null],
  ]);
}

export function renderScanResults(results: ScanResults): void {
  printKv([
    ["Batch ID", results.batch_id],
    ["Scan type", results.scan_type],
    ["Status", results.status],
    ["Findings", results.findings_count],
  ]);
  if (results.findings.length === 0) {
    process.stdout.write(chalk.dim("\nNo findings.\n"));
    return;
  }
  process.stdout.write("\n");
  const table = new Table({
    head: ["Severity", "Check", "File", "Message"],
    colWidths: [12, 24, 32, 60],
    wordWrap: true,
    style: { head: ["cyan"] },
  });
  for (const f of results.findings) {
    table.push([colorSeverity(f.severity), f.check_id, f.file_path, f.message]);
  }
  process.stdout.write(table.toString() + "\n");
}

export function renderFindingsTable(findings: readonly Finding[]): void {
  if (findings.length === 0) {
    process.stdout.write(chalk.dim("No findings.\n"));
    return;
  }
  const table = new Table({
    head: ["ID", "Severity", "Status", "Check", "File", "Scan type"],
    colWidths: [24, 10, 12, 24, 40, 12],
    wordWrap: true,
    style: { head: ["cyan"] },
  });
  for (const f of findings) {
    table.push([
      f.id,
      colorSeverity(f.severity),
      colorStatus(f.status),
      f.check_id,
      f.file_path,
      f.scan_type,
    ]);
  }
  process.stdout.write(table.toString() + "\n");
}

export function renderFinding(finding: Finding): void {
  printKv([
    ["ID", finding.id],
    ["Application", finding.application_id],
    ["Severity", finding.severity],
    ["Status", finding.status],
    ["Check", finding.check_id],
    ["File", finding.file_path],
    ["Category", finding.category],
    ["Scan type", finding.scan_type],
    ["Message", finding.message],
    ["CWE", finding.cwe?.join(", ") ?? null],
    ["OWASP", finding.owasp?.join(", ") ?? null],
    ["CVSS", finding.cvss_base_score ?? null],
    ["First detected", fmtDate(finding.first_detected_at)],
    ["Last detected", fmtDate(finding.last_detected_at)],
    ["Resolved", finding.resolved_at ? fmtDate(finding.resolved_at) : null],
  ]);
}

export function renderFixesTable(fixes: readonly Fix[]): void {
  if (fixes.length === 0) {
    process.stdout.write(chalk.dim("No fixes.\n"));
    return;
  }
  const table = new Table({
    head: ["ID", "Status", "Title", "Findings", "PRs", "Created"],
    style: { head: ["cyan"] },
  });
  for (const f of fixes) {
    table.push([
      f.id,
      colorStatus(f.status),
      truncate(f.title, 40),
      String(f.finding_ids.length),
      String(f.pull_requests?.length ?? 0),
      fmtDate(f.created_at),
    ]);
  }
  process.stdout.write(table.toString() + "\n");
}

export function renderFix(fix: Fix): void {
  printKv([
    ["ID", fix.id],
    ["Title", fix.title],
    ["Status", fix.status],
    ["Findings", fix.finding_ids.join(", ")],
    ["Source repo", fix.source_repo ?? null],
    ["Provider", fix.source_repo_provider ?? null],
    ["Source branch", fix.source_scan_branch ?? null],
    ["Created", fmtDate(fix.created_at)],
    ["Started", fix.started_at ? fmtDate(fix.started_at) : null],
    ["Completed", fix.completed_at ? fmtDate(fix.completed_at) : null],
    ["Error", fix.error_message ?? null],
  ]);
  if (fix.pull_requests && fix.pull_requests.length > 0) {
    process.stdout.write(chalk.dim("\nPull requests:\n"));
    for (const pr of fix.pull_requests) {
      process.stdout.write(`  ${chalk.cyan(pr.repo_full_name)}#${pr.pr_number}  ${pr.pr_url}\n`);
    }
  }
}

export function renderQuota(balance: QuotaBalance): void {
  printKv([
    ["Period start", fmtDate(balance.period_start)],
    ["Period end", fmtDate(balance.period_end)],
  ]);
  const table = new Table({
    head: ["Counter", "Plan", "Topup", "Used", "Remaining"],
    style: { head: ["cyan"] },
  });
  const push = (label: string, counter: QuotaCounter): void => {
    const remaining =
      counter.remaining === 0 ? chalk.red("0") : chalk.green(String(counter.remaining));
    table.push([label, counter.plan, counter.topup, counter.used, remaining]);
  };
  push("PRs", balance.prs);
  push("SAST scans", balance.sast_scans);
  push("Deep AI scans", balance.deep_ai_scans);
  process.stdout.write("\n" + table.toString() + "\n");
  process.stdout.write(
    `${chalk.dim("Applications:")} ${balance.applications.current}` +
      (balance.applications.max !== null && balance.applications.max !== undefined
        ? ` / ${balance.applications.max}\n`
        : "\n"),
  );
}

// ---------- Progress rendering ----------

export interface ScanProgressRenderState {
  lastRender: string;
}

export function renderScanProgress(progress: ScanProgress, state: ScanProgressRenderState): void {
  const lines: string[] = [];
  const pct = Math.max(0, Math.min(100, Math.round(progress.percent_complete)));
  lines.push(
    `${chalk.bold("Scan")} ${chalk.cyan(progress.batch_id)}  ${colorStatus(progress.status)}  ${pct}%`,
  );
  lines.push(progressBar(pct, 40));
  lines.push(
    `${chalk.dim("Repos:")} ${progress.scans_completed}/${progress.total_repositories} completed, ${progress.scans_failed} failed`,
  );
  const repos = progress.repositories ?? [];
  for (const r of repos.slice(0, 10)) {
    lines.push(
      `  ${chalk.dim("•")} ${r.repository}@${r.branch}  ${colorStatus(r.status)}` +
        (r.findings_count !== null && r.findings_count !== undefined
          ? `  ${chalk.dim(`${r.findings_count} findings`)}`
          : ""),
    );
  }
  if (repos.length > 10) {
    lines.push(chalk.dim(`  … ${repos.length - 10} more`));
  }
  if (progress.error_message) {
    lines.push(chalk.red(progress.error_message));
  }
  const rendered = lines.join("\n");
  writeUpdatable(rendered, state);
}

export interface FixHeartbeatRenderState {
  lastRender: string;
}

export function renderFixHeartbeat(
  progress: FixProgress,
  state: FixHeartbeatRenderState,
  now: number = Date.now(),
): void {
  const parts: string[] = [];
  parts.push(`${chalk.bold("Fix")} ${chalk.cyan(progress.fix_id)}`);
  parts.push(colorStatus(progress.status));
  if (progress.duration_seconds !== null && progress.duration_seconds !== undefined) {
    parts.push(`${Math.round(progress.duration_seconds)}s`);
  }
  parts.push(`${progress.agent_steps_completed} steps`);
  if (progress.latest_activity_at) {
    const ageMs = now - Date.parse(progress.latest_activity_at);
    if (!Number.isNaN(ageMs) && ageMs >= 0) {
      parts.push(`last activity ${formatAge(ageMs)} ago`);
    }
  }
  if (progress.error_message) {
    parts.push(chalk.red(progress.error_message));
  }
  const rendered = parts.join(chalk.dim(" — "));
  writeUpdatable(rendered, state);
}

function writeUpdatable(rendered: string, state: { lastRender: string }): void {
  if (!isTty()) {
    if (rendered !== state.lastRender) {
      process.stdout.write(rendered + "\n");
      state.lastRender = rendered;
    }
    return;
  }
  // Clear previous render in-place, then write the new one.
  const prevLines = state.lastRender ? state.lastRender.split("\n").length : 0;
  for (let i = 0; i < prevLines; i++) {
    process.stdout.write("\x1b[1A"); // up
    process.stdout.write("\x1b[2K"); // clear line
  }
  process.stdout.write(rendered + "\n");
  state.lastRender = rendered;
}

function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return `${chalk.green("█".repeat(filled))}${chalk.dim("░".repeat(empty))}  ${pct}%`;
}

function colorStatus(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("fail") || s === "error" || s === "cancelled") return chalk.red(status);
  if (s === "completed" || s === "succeeded" || s === "resolved") return chalk.green(status);
  if (s === "running" || s === "in_progress" || s === "queued" || s === "creating_scans")
    return chalk.yellow(status);
  if (s === "open") return chalk.magenta(status);
  return status;
}

function colorSeverity(severity: string): string {
  const s = severity.toLowerCase();
  if (s === "critical") return chalk.bgRed.white(` ${severity} `);
  if (s === "high") return chalk.red(severity);
  if (s === "medium") return chalk.yellow(severity);
  if (s === "low") return chalk.cyan(severity);
  return chalk.dim(severity);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\..+$/, "Z");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}
