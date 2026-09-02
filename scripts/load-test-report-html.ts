export interface ReportMetadata {
  runId: string;
  scenario: string;
  environment: string;
  profile: string;
  baseUrl: string;
  startedAt: string;
  completedAt?: string;
  status: string;
  exitCode?: number;
  command: string;
}

export interface ReportCheck {
  name: string;
  passes: number;
  fails: number;
}

export interface ReportThreshold {
  metric: string;
  expression: string;
  passed: boolean;
}

export interface k6ReportData {
  scenario: string;
  environment: string;
  generatedAt: string;
  reportDate: string;
  htmlPath: string;
  pdfPath: string;
  runId: string;
  metadata: ReportMetadata;
  summary: Record<string, any>;
  
  // Analyzed fields
  testType: string;
  testProfile: string;
  startedAt: string;
  completedAt: string;
  durationStr: string;
  vusMax: number;
  totalRequests: number;
  rps: number;
  successfulRequests: number;
  failedRequests: number;
  httpFailureRate: number;
  
  checksTotal: number;
  checksPassed: number;
  checksFailed: number;
  checkSuccessRate: number;
  
  avgResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  p90ResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number | 'N/A';
  
  dataReceivedBytes: number;
  dataSentBytes: number;
  
  thresholds: ReportThreshold[];
  finalStatus: 'PASS' | 'FAIL';
  failureReasons: string[];
}

function escapeHtml(value: string | undefined): string {
  if (!value) return 'N/A';
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatNumber(value: number | undefined, digits = 2): string {
  if (value === undefined || Number.isNaN(value)) {
    return 'N/A';
  }
  return value.toLocaleString('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function formatMs(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) {
    return 'N/A';
  }
  if (value >= 1000) {
    return `${formatNumber(value / 1000, 2)} s`;
  }
  return `${formatNumber(value, 1)} ms`;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) {
    return 'N/A';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${formatNumber(size, 2)} ${units[unitIndex]}`;
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return 'N/A';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return escapeHtml(value);
  }
  return escapeHtml(date.toISOString().replace('T', ' ').replace('Z', ' UTC'));
}

export function buildLoadTestReportHtml(data: k6ReportData): string {
  // Generate SVG Donut for Check Success Rate
  const radius = 45;
  const stroke = 10;
  const normalizedRadius = radius - stroke * 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const successPercent = data.checkSuccessRate * 100;
  const strokeDashoffset = circumference - (data.checkSuccessRate) * circumference;
  const donutColor = data.checkSuccessRate >= 0.99 ? '#0f7a43' : data.checkSuccessRate >= 0.95 ? '#d97706' : '#b42318';

  // Generate SVG Bar Chart for response times
  const latencies = [
    { label: 'Min', val: data.minResponseTime },
    { label: 'Avg', val: data.avgResponseTime },
    { label: 'P90', val: data.p90ResponseTime },
    { label: 'P95', val: data.p95ResponseTime }
  ];
  const maxLat = Math.max(...latencies.map(l => l.val), 1);
  const barChartWidth = 400;
  const barChartHeight = 150;
  const barWidth = 50;
  const gap = 35;
  const chartBarsSvg = latencies.map((l, idx) => {
    const rectHeight = (l.val / maxLat) * (barChartHeight - 40);
    const x = idx * (barWidth + gap) + 40;
    const y = barChartHeight - rectHeight - 25;
    return `
      <g>
        <rect x="${x}" y="${y}" width="${barWidth}" height="${rectHeight}" fill="#0b3d5c" rx="4" />
        <text x="${x + barWidth / 2}" y="${y - 8}" text-anchor="middle" font-size="11" font-weight="bold" fill="#122033">${formatMs(l.val)}</text>
        <text x="${x + barWidth / 2}" y="${barChartHeight - 8}" text-anchor="middle" font-size="11" fill="#5b6b7c" font-weight="600">${l.label}</text>
      </g>
    `;
  }).join('');

  // 7. Dynamic and Grounded Performance Analysis Generation (No invented conclusions)
  let performanceAnalysisHtml = `
    <p>This performance evaluation report summarizes load parameters and telemetry benchmarks collected during execution of the <strong>${escapeHtml(data.scenario)}</strong> performance scenario in the <strong>${escapeHtml(data.environment)}</strong> environment. The test run was executed under a peak load level of <strong>${formatNumber(data.vusMax, 0)} concurrent virtual users (VUs)</strong> using the <strong>${escapeHtml(data.testProfile)}</strong> profile, spanning an active run duration of <strong>${escapeHtml(data.durationStr)}</strong>.</p>
    
    <p>Overall response time characteristics show a baseline mean request latency of <strong>${formatMs(data.avgResponseTime)}</strong>. The 95th percentile (P95) latency was recorded at <strong>${formatMs(data.p95ResponseTime)}</strong>, indicating that 95% of request cycles were fully completed within this limit. The 99th percentile (P99) response time is <strong>${data.p99ResponseTime === 'N/A' ? 'not available in the summary dataset (N/A)' : `<strong>${formatMs(data.p99ResponseTime as number)}</strong>`}</strong>.</p>
    
    <p>In terms of workload volume and system throughput, the performance runner successfully dispatched <strong>${formatNumber(data.totalRequests, 0)}</strong> cumulative requests, maintaining an average request throughput rate of <strong>${formatNumber(data.rps, 2)} requests per second (RPS)</strong>. This throughput resulted in <strong>${formatBytes(data.dataSentBytes)}</strong> in total outbound data transmitted and <strong>${formatBytes(data.dataReceivedBytes)}</strong> in total inbound page-weight payloads received from the application tier.</p>
    
    <p>Under these load parameters, functional checkpoints achieved a check success rate of <strong>${formatNumber(data.checkSuccessRate * 100, 2)}%</strong>, with <strong>${formatNumber(data.checksPassed, 0)}</strong> assertions passing and <strong>${formatNumber(data.checksFailed, 0)}</strong> assertions registering failures. Out of all requests transmitted by the load generation engine, the HTTP request failure rate was <strong>${formatNumber(data.httpFailureRate * 100, 2)}%</strong>, with <strong>${formatNumber(data.failedRequests, 0)}</strong> requests failing to return successful status codes.</p>
  `;

  // SLA / Threshold compliance section based strictly on actual configuration
  if (data.thresholds.length > 0) {
    const passedCount = data.thresholds.filter(t => t.passed).length;
    const failedCount = data.thresholds.length - passedCount;
    performanceAnalysisHtml += `
      <p>Performance boundaries were evaluated against <strong>${data.thresholds.length}</strong> configured service-level agreement (SLA) threshold specifications. Of these configured criteria, <strong>${passedCount} passed</strong> and <strong>${failedCount} failed</strong>. Specifically, `;
    
    if (failedCount === 0) {
      performanceAnalysisHtml += `all latency and error constraints remained within configured limits, verifying threshold compliance.`;
    } else {
      const failedList = data.thresholds.filter(t => !t.passed).map(t => `${escapeHtml(t.metric)} (${escapeHtml(t.expression)})`).join(', ');
      performanceAnalysisHtml += `one or more performance requirements were breached. The following threshold limits were crossed: <strong>${failedList}</strong>.`;
    }
    performanceAnalysisHtml += `</p>`;
  } else {
    performanceAnalysisHtml += `
      <p>SLA threshold compliance cannot be verified as no active load thresholds were configured for this test scenario run.</p>
    `;
  }

  // 8. Dynamic and Grounded Errors and Failures Section (No invented conclusions)
  let errorsSectionHtml = '';
  if (data.finalStatus === 'PASS') {
    errorsSectionHtml = `
      <p class="ok">Zero errors, Exceptions, network timeouts, or functional validation issues were recorded. The target system successfully supported the concurrent workload without experiencing transaction failures or SLA boundary crossings.</p>
    `;
  } else {
    errorsSectionHtml = `
      <div class="warn" style="border-left: 4px solid var(--bad); padding: 15px; background: #fffafb; border-radius: 4px;">
        <p class="bad" style="margin-bottom: 8px;">The performance execution failed to satisfy all criteria. The following specific failure categories were logged:</p>
        <ul style="margin: 0; padding-left: 18px; line-height: 1.6;">
    `;
    
    if (data.httpFailureRate > 0) {
      errorsSectionHtml += `<li><strong>Network Error Exception:</strong> The test recorded HTTP request failures with a failure rate of <strong>${formatNumber(data.httpFailureRate * 100, 2)}%</strong> (${formatNumber(data.failedRequests, 0)} failed requests). This indicates that the target server dropped connections, timed out, or returned HTTP status errors under load.</li>`;
    }
    if (data.checksFailed > 0) {
      errorsSectionHtml += `<li><strong>Assertion Validation Exception:</strong> A total of <strong>${formatNumber(data.checksFailed, 0)}</strong> verification checks failed. This means the application server returned incorrect layouts, missing content nodes, or invalid session profiles.</li>`;
    }
    
    const failedThresholds = data.thresholds.filter(t => !t.passed);
    if (failedThresholds.length > 0) {
      errorsSectionHtml += `<li><strong>SLA Threshold Crossings:</strong> Confirmed crossing of <strong>${failedThresholds.length}</strong> service thresholds. The metrics did not sustain the targeted latency limits during the test.</li>`;
    }
    
    if (data.metadata.exitCode && data.metadata.exitCode !== 0) {
      errorsSectionHtml += `<li><strong>Runner Execution Exception:</strong> The performance engine exited with a non-zero exit status code of <strong>${data.metadata.exitCode}</strong>.</li>`;
    }

    errorsSectionHtml += `
        </ul>
        <p style="margin-top: 12px; font-size: 12px; color: var(--muted); margin-bottom: 0;">Recommendations and remediation actions based strictly on these diagnostic data elements are listed below.</p>
      </div>
    `;
  }

  // Generate Recommendations
  const recommendations: string[] = [];
  if (data.finalStatus === 'PASS') {
    recommendations.push("Maintain current system configuration as performance characteristics are stable.");
    recommendations.push("Continue scheduling regular regression load runs under similar profiles to trace codebase changes.");
    recommendations.push("Consider expanding the stress limits or testing soak robustness in dev/live environment to find absolute capacity.");
  } else {
    if (data.httpFailureRate > 0) {
      recommendations.push("Investigate web server or API gateway access logs for standard HTTP 5xx Server Errors or HTTP 429 Too Many Requests.");
      recommendations.push("Determine if database connection bottlenecks, memory leaks, or execution pool exhaustion is causing dropped requests under load.");
    }
    if (data.checksFailed > 0) {
      recommendations.push("Review response content validation checks. Investigate if HTML components or specific DOM selectors were missing during page load.");
      recommendations.push("Validate system authentication states and session validity under concurrent conditions.");
    }
    if (data.avgResponseTime > 3000) {
      recommendations.push("Optimize time-to-first-byte (TTFB) or static asset caches, as homepage/SPA loading metrics dominate duration.");
    }
    if (data.failureReasons.length > 0) {
      recommendations.push("Review target application resource allocations (CPU/RAM scaling) on the target host environment.");
    }
    recommendations.push("After system optimization, re-run tests with smoke and load profiles to verify metrics normalization.");
  }

  const recommendationListHtml = recommendations.map(rec => `<li>${rec}</li>`).join('');

  // Generate Threshold table rows
  const thresholdRows = data.thresholds.map(t => {
    const cls = t.passed ? 'ok' : 'bad';
    return `
      <tr>
        <td class="mono">${escapeHtml(t.metric)}</td>
        <td class="mono">${escapeHtml(t.expression)}</td>
        <td class="${cls}">${t.passed ? 'PASSED' : 'FAILED'}</td>
      </tr>
    `;
  }).join('');

  // Generate Individual Checks table rows
  const checks = data.summary.root_group?.checks;
  let checkRows = '';
  if (checks && typeof checks === 'object') {
    checkRows = Object.entries(checks).map(([name, val]: [string, any]) => {
      const passes = val.passes ?? 0;
      const fails = val.fails ?? 0;
      const total = passes + fails;
      const rate = total > 0 ? (passes / total) * 100 : 0;
      const cls = fails === 0 ? 'ok' : 'bad';
      return `
        <tr>
          <td>${escapeHtml(name)}</td>
          <td>${formatNumber(passes, 0)}</td>
          <td class="${cls}">${formatNumber(fails, 0)}</td>
          <td class="${cls}">${formatNumber(rate, 2)}%</td>
        </tr>
      `;
    }).join('');
  } else {
    checkRows = '<tr><td colspan="4" class="muted text-center">No checks defined in this test scenario.</td></tr>';
  }

  // Generate Full Metrics tables
  const fullMetricsHtml = Object.entries(data.summary.metrics ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, metric]: [string, any]) => {
      const entries = Object.entries(metric)
        .filter(([k]) => k !== 'thresholds')
        .map(([k, v]) => {
          let strVal = '';
          if (typeof v === 'object' && v !== null) {
            strVal = JSON.stringify(v);
          } else if (typeof v === 'number') {
            if (name.includes('duration') || ['avg', 'min', 'max', 'med', 'p(90)', 'p(95)', 'p(99)'].includes(k)) {
              strVal = formatMs(v);
            } else if (name.includes('data_') || name.includes('sent') || name.includes('received')) {
              strVal = formatBytes(v);
            } else {
              strVal = formatNumber(v, 4);
            }
          } else {
            strVal = String(v);
          }
          return `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(strVal)}</td></tr>`;
        }).join('');
      return `
        <div class="metric-card">
          <h4>${escapeHtml(name)}</h4>
          <table>
            <tbody>
              ${entries}
            </tbody>
          </table>
        </div>
      `;
    }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>k6 Load Test Report - ${escapeHtml(data.scenario)}</title>
  <style>
    :root {
      --primary: #0f172a;
      --secondary: #0b3d5c;
      --accent: #0d9488;
      --ink: #1e293b;
      --muted: #64748b;
      --line: #cbd5e1;
      --wash: #f8fafc;
      --paper: #ffffff;
      
      --ok: #0f7a43;
      --ok-bg: #e7f6ee;
      --bad: #b42318;
      --bad-bg: #fde8e6;
    }
    
    * { box-sizing: border-box; }
    
    body {
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
    }
    
    .page-wrapper {
      max-width: 900px;
      margin: 0 auto;
      padding: 0;
    }
    
    /* Cover / Hero header */
    .report-hero {
      background: var(--primary);
      color: var(--paper);
      padding: 40px 50px;
      border-bottom: 5px solid var(--accent);
    }
    
    .report-hero .eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 11px;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 8px;
    }
    
    .report-hero h1 {
      font-size: 30px;
      font-weight: 800;
      margin: 0 0 12px;
      letter-spacing: -0.025em;
    }
    
    .report-hero p {
      font-size: 14px;
      color: #94a3b8;
      margin: 0 0 20px;
      max-width: 700px;
    }
    
    .hero-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    
    .meta-chip {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 9999px;
      padding: 4px 12px;
      font-size: 11px;
      font-weight: 600;
      color: #cbd5e1;
    }
    
    /* Content sections */
    .content-body {
      padding: 40px 50px;
    }
    
    h2 {
      font-size: 18px;
      font-weight: 700;
      color: var(--primary);
      border-bottom: 2px solid var(--primary);
      padding-bottom: 6px;
      margin: 35px 0 15px;
    }
    
    h2:first-of-type {
      margin-top: 0;
    }
    
    h3 {
      font-size: 14px;
      font-weight: 700;
      color: var(--secondary);
      margin: 20px 0 10px;
    }
    
    p {
      margin: 0 0 12px;
      color: var(--ink);
    }
    
    /* Layouts and Panels */
    .result-banner {
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 25px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }
    
    .result-banner.passed {
      background-color: var(--ok-bg);
      border: 1px solid #a7f3d0;
    }
    
    .result-banner.failed {
      background-color: var(--bad-bg);
      border: 1px solid #fecaca;
    }
    
    .result-banner-text h3 {
      margin: 0 0 5px;
      font-size: 20px;
    }
    .result-banner.passed h3 { color: var(--ok); }
    .result-banner.failed h3 { color: var(--bad); }
    
    .result-banner-text p {
      margin: 0;
      font-size: 13px;
      color: var(--ink);
    }
    
    .badge-status {
      font-size: 18px;
      font-weight: 800;
      padding: 8px 24px;
      border-radius: 6px;
      letter-spacing: 0.05em;
    }
    .badge-status.passed {
      background-color: var(--ok);
      color: var(--paper);
    }
    .badge-status.failed {
      background-color: var(--bad);
      color: var(--paper);
    }
    
    /* Grid system */
    .grid-kpis {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 25px;
    }
    
    .kpi-card {
      background: var(--wash);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 15px;
      text-align: center;
    }
    
    .kpi-card span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }
    
    .kpi-card strong {
      font-size: 20px;
      font-weight: 800;
      color: var(--primary);
    }
    
    .chart-box-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 25px;
    }
    
    .chart-box {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 15px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    
    .chart-box h4 {
      margin: 0 0 15px;
      font-size: 13px;
      font-weight: 700;
      color: var(--secondary);
      width: 100%;
      text-align: left;
    }
    
    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
    }
    
    th, td {
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    
    thead th {
      background-color: var(--wash);
      font-weight: 700;
      color: var(--primary);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    table.kv-table th {
      width: 180px;
      font-weight: 700;
      color: var(--muted);
      background-color: transparent;
      border-bottom: 1px solid var(--wash);
    }
    
    table.kv-table td {
      border-bottom: 1px solid var(--wash);
    }
    
    .mono {
      font-family: Consolas, "Courier New", monospace;
      font-size: 12px;
    }
    
    .ok { color: var(--ok); font-weight: bold; }
    .bad { color: var(--bad); font-weight: bold; }
    
    ul {
      margin: 0 0 15px;
      padding-left: 20px;
    }
    
    li {
      margin-bottom: 6px;
    }
    
    /* Metrics display */
    .metric-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
    }
    
    .metric-card {
      background: var(--wash);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px;
    }
    
    .metric-card h4 {
      margin: 0 0 8px;
      font-size: 12px;
      color: var(--secondary);
      border-bottom: 1px solid var(--line);
      padding-bottom: 4px;
    }
    
    .metric-card table {
      margin: 0;
      font-size: 11px;
    }
    
    .metric-card th, .metric-card td {
      padding: 4px 6px;
      border: none;
    }
    
    .metric-card th {
      color: var(--muted);
      width: 110px;
    }
    
    .text-center {
      text-align: center;
    }
    
    /* Print utilities */
    .page-break {
      page-break-before: always;
    }
    
    @media print {
      body {
        background-color: #fff;
        font-size: 12px;
      }
      .page-wrapper {
        max-width: 100%;
        padding: 0;
      }
      .content-body {
        padding: 20px 30px;
      }
      .grid-kpis {
        gap: 8px;
      }
      .kpi-card {
        padding: 10px;
      }
      .chart-box-row {
        gap: 12px;
      }
      .metric-grid {
        grid-template-columns: 1fr;
      }
      h2 {
        margin-top: 25px;
      }
    }
  </style>
</head>
<body>
  <div class="page-wrapper">
    <header class="report-hero">
      <div class="eyebrow">CalicoDesk Load-Testing Engine</div>
      <h1>Performance Verification Report</h1>
      <p>Independent load verification audit. Generated from detailed sub-second telemetry summary archives. Validates assertion rulesets and network service level agreements (SLAs).</p>
      <div class="hero-meta">
        <span class="meta-chip">Scenario: ${escapeHtml(data.scenario)}</span>
        <span class="meta-chip">Environment: ${escapeHtml(data.environment)}</span>
        <span class="meta-chip">Run ID: ${escapeHtml(data.runId)}</span>
        <span class="meta-chip">Report Date: ${escapeHtml(data.reportDate)}</span>
        <span class="meta-chip">Executed: ${formatDateTime(data.metadata.startedAt)}</span>
      </div>
    </header>
    
    <main class="content-body">
      
      <!-- 1. Executive Summary & Final Result -->
      <section>
        <h2>1. Executive Summary & Final Result</h2>
        
        <div class="result-banner ${data.finalStatus === 'PASS' ? 'passed' : 'failed'}">
          <div class="result-banner-text">
            <h3>System Audit Status: ${data.finalStatus}</h3>
            <p>The performance validation completed with an overall <strong>${data.finalStatus}</strong> outcome based on functional checks, network response thresholds, and communication stability parameters.</p>
          </div>
          <div class="badge-status ${data.finalStatus === 'PASS' ? 'passed' : 'failed'}">
            ${data.finalStatus}
          </div>
        </div>
        
        <div class="grid-kpis">
          <div class="kpi-card">
            <span>Overall Result</span>
            <strong class="${data.finalStatus === 'PASS' ? 'ok' : 'bad'}">${data.finalStatus}</strong>
          </div>
          <div class="kpi-card">
            <span>Avg Response Time</span>
            <strong>${formatMs(data.avgResponseTime)}</strong>
          </div>
          <div class="kpi-card">
            <span>Check Success Rate</span>
            <strong class="${data.checkSuccessRate >= 0.99 ? 'ok' : 'bad'}">${formatNumber(data.checkSuccessRate * 100, 2)}%</strong>
          </div>
          <div class="kpi-card">
            <span>HTTP Failure Rate</span>
            <strong class="${data.httpFailureRate === 0 ? 'ok' : 'bad'}">${formatNumber(data.httpFailureRate * 100, 2)}%</strong>
          </div>
        </div>
        
        <div class="chart-box-row">
          <div class="chart-box">
            <h4>Check Success Rate Summary</h4>
            <svg width="180" height="130" viewBox="0 0 100 100">
              <!-- Background Circle -->
              <circle cx="50" cy="50" r="${normalizedRadius}" fill="transparent" stroke="#e2e8f0" stroke-width="${stroke}" />
              <!-- Foreground Arc -->
              <circle cx="50" cy="50" r="${normalizedRadius}" fill="transparent" stroke="${donutColor}" stroke-width="${stroke}" 
                      stroke-dasharray="${circumference}" stroke-dashoffset="${strokeDashoffset}" 
                      transform="rotate(-90 50 50)" stroke-linecap="round" />
              <!-- Text in Center -->
              <text x="50" y="55" font-size="14" font-weight="800" text-anchor="middle" fill="#1e293b">${formatNumber(successPercent, 1)}%</text>
            </svg>
          </div>
          <div class="chart-box">
            <h4>Latency Percentile Profiles</h4>
            <svg width="${barChartWidth}" height="${barChartHeight}">
              <!-- Grid line base -->
              <line x1="15" y1="${barChartHeight - 25}" x2="${barChartWidth - 15}" y2="${barChartHeight - 25}" stroke="#cbd5e1" stroke-width="1.5" />
              ${chartBarsSvg}
            </svg>
          </div>
        </div>
      </section>
      
      <!-- 2. Test Configuration -->
      <section class="page-break">
        <h2>2. Test Configuration</h2>
        <table class="kv-table">
          <tbody>
            <tr>
              <th>Performance Scenario</th>
              <td><strong>${escapeHtml(data.scenario)}</strong></td>
            </tr>
            <tr>
              <th>Target Environment</th>
              <td><strong>${escapeHtml(data.environment)}</strong></td>
            </tr>
            <tr>
              <th>Base System Endpoint</th>
              <td class="mono">${escapeHtml(data.metadata.baseUrl)}</td>
            </tr>
            <tr>
              <th>Internal Run ID</th>
              <td class="mono">${escapeHtml(data.runId)}</td>
            </tr>
            <tr>
              <th>Execution Timestamp (Start)</th>
              <td>${formatDateTime(data.metadata.startedAt)}</td>
            </tr>
            <tr>
              <th>Execution Timestamp (End)</th>
              <td>${formatDateTime(data.metadata.completedAt)}</td>
            </tr>
            <tr>
              <th>Total Execution Span</th>
              <td>${escapeHtml(data.durationStr)}</td>
            </tr>
            <tr>
              <th>Console Execution Command</th>
              <td class="mono" style="font-size: 11px;">${escapeHtml(data.metadata.command)}</td>
            </tr>
          </tbody>
        </table>
      </section>
      
      <!-- 3. Load Profile -->
      <section>
        <h2>3. Load Profile</h2>
        <p>The k6 load injector applied a load schedule designed to match realistic production levels. Key volume parameters include:</p>
        <table class="kv-table">
          <tbody>
            <tr>
              <th>Simulated Load Profile</th>
              <td><strong>${escapeHtml(data.testProfile)}</strong></td>
            </tr>
            <tr>
              <th>Peak Concurrency Limit</th>
              <td><strong>${formatNumber(data.vusMax, 0)} Concurrent Virtual Users (VUs)</strong></td>
            </tr>
            <tr>
              <th>Total Executed Iterations</th>
              <td>${formatNumber(data.summary.metrics?.iterations?.count, 0)} complete workflow iterations</td>
            </tr>
            <tr>
              <th>Iteration Frequency (RPS)</th>
              <td>${formatNumber(data.summary.metrics?.iterations?.rate, 2)} iterations per second</td>
            </tr>
          </tbody>
        </table>
      </section>
      
      <!-- 4. HTTP Performance -->
      <section class="page-break">
        <h2>4. HTTP Performance</h2>
        <p>Telemetry metrics tracking end-to-end socket request cycles from the load engine to the target servers:</p>
        <table>
          <thead>
            <tr>
              <th>Performance Area</th>
              <th>k6 Metric Identifier</th>
              <th>Avg Latency</th>
              <th>P90 Latency</th>
              <th>P95 Latency</th>
              <th>Peak Max Latency</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>End-to-End Latency</strong></td>
              <td class="mono">http_req_duration</td>
              <td>${formatMs(data.avgResponseTime)}</td>
              <td>${formatMs(data.p90ResponseTime)}</td>
              <td>${formatMs(data.p95ResponseTime)}</td>
              <td>${formatMs(data.maxResponseTime)}</td>
            </tr>
            <tr>
              <td><strong>Time-to-First-Byte (TTFB)</strong></td>
              <td class="mono">http_req_waiting</td>
              <td>${formatMs(data.summary.metrics?.http_req_waiting?.avg)}</td>
              <td>${formatMs(data.summary.metrics?.http_req_waiting?.['p(90)'])}</td>
              <td>${formatMs(data.summary.metrics?.http_req_waiting?.['p(95)'])}</td>
              <td>${formatMs(data.summary.metrics?.http_req_waiting?.max)}</td>
            </tr>
            <tr>
              <td><strong>Payload Receiving Time</strong></td>
              <td class="mono">http_req_receiving</td>
              <td>${formatMs(data.summary.metrics?.http_req_receiving?.avg)}</td>
              <td>${formatMs(data.summary.metrics?.http_req_receiving?.['p(90)'])}</td>
              <td>${formatMs(data.summary.metrics?.http_req_receiving?.['p(95)'])}</td>
              <td>${formatMs(data.summary.metrics?.http_req_receiving?.max)}</td>
            </tr>
            <tr>
              <td><strong>Workflow Iteration Duration</strong></td>
              <td class="mono">iteration_duration</td>
              <td>${formatMs(data.summary.metrics?.iteration_duration?.avg)}</td>
              <td>${formatMs(data.summary.metrics?.iteration_duration?.['p(90)'])}</td>
              <td>${formatMs(data.summary.metrics?.iteration_duration?.['p(95)'])}</td>
              <td>${formatMs(data.summary.metrics?.iteration_duration?.max)}</td>
            </tr>
          </tbody>
        </table>
        
        <h3>Throughput and Bandwidth</h3>
        <table class="kv-table">
          <tbody>
            <tr>
              <th>Total Transferred Outbound</th>
              <td>${formatBytes(data.dataSentBytes)} (${formatBytes(data.summary.metrics?.data_sent?.rate)}/sec)</td>
            </tr>
            <tr>
              <th>Total Transferred Inbound</th>
              <td>${formatBytes(data.dataReceivedBytes)} (${formatBytes(data.summary.metrics?.data_received?.rate)}/sec)</td>
            </tr>
            <tr>
              <th>Aggregate Request Count</th>
              <td><strong>${formatNumber(data.totalRequests, 0)} total requests</strong></td>
            </tr>
            <tr>
              <th>Aggregate Request Speed</th>
              <td><strong>${formatNumber(data.rps, 2)} req/sec (RPS)</strong></td>
            </tr>
          </tbody>
        </table>
      </section>
      
      <!-- 5. Assertion Checks -->
      <section>
        <h2>5. Assertion Checks</h2>
        <p>Specific workflow checkpoints validating status code outcomes, page structures, or database payloads under concurrent load conditions:</p>
        <table>
          <thead>
            <tr>
              <th>Target Check Name</th>
              <th>Passes</th>
              <th>Fails</th>
              <th>Check Success Rate</th>
            </tr>
          </thead>
          <tbody>
            ${checkRows}
          </tbody>
        </table>
      </section>
      
      <!-- 6. Service Level Thresholds (SLAs) -->
      <section class="page-break">
        <h2>6. Service Level Thresholds (SLAs)</h2>
        <p>Automated pass/fail boundaries (threshold limits) configured on key metrics to enforce service agreements:</p>
        ${data.thresholds.length === 0 ? 
          '<p class="muted">No load thresholds were configured for this test run.</p>' : 
          `<table>
            <thead>
              <tr>
                <th>Target Metric</th>
                <th>SLA Boundary Criteria</th>
                <th>Threshold Result Status</th>
              </tr>
            </thead>
            <tbody>
              ${thresholdRows}
            </tbody>
          </table>`
        }
      </section>
      
      <!-- 7. Performance Analysis -->
      <section>
        <h2>7. Performance Analysis</h2>
        <div style="line-height: 1.6;">
          ${performanceAnalysisHtml}
        </div>
      </section>
      
      <!-- 8. Errors and Failures -->
      <section>
        <h2>8. Errors and Failures</h2>
        <div style="line-height: 1.6;">
          ${errorsSectionHtml}
        </div>
      </section>
      
      <!-- 9. Recommendations -->
      <section class="page-break">
        <h2>9. Architectural Recommendations</h2>
        <p>Based on the system performance profile, we advise the following immediate course corrections:</p>
        <ul style="line-height: 1.6;">
          ${recommendationListHtml}
        </ul>
      </section>
      
      <!-- 10. Complete Telemetry Matrix -->
      <section>
        <h2>10. Complete Telemetry Matrix</h2>
        <p>Raw telemetry aggregate buckets parsed directly from the summary JSON export payload:</p>
        <div class="metric-grid">
          ${fullMetricsHtml}
        </div>
      </section>
      
    </main>
  </div>
</body>
</html>`;
}
