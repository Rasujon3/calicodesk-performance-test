import { chromium } from 'playwright';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isTestEnvironment,
  testEnvironments,
  type TestEnvironment,
} from '../config/base-url.js';
import {
  buildLoadTestReportHtml,
  type ReportMetadata,
  type ReportThreshold,
  type k6ReportData,
} from './load-test-report-html.js';

type Scenario = 'homepage' | 'authentication';

const validScenarios: Scenario[] = [
  'homepage',
  'authentication',
];

function getArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function printUsage(): void {
  console.log(`
CalicoDesk k6 Professional Load Test Report Generator

Reads a completed k6 run under scenarios/<scenario>/reports/k6/<env>/
and generates a professional, presentation-ready executive HTML and PDF report.

Usage:
  npm run loadtestresport -- --scenario <scenario> --env <environment> [--run-id <run-id>]

Scenarios:
  homepage
  authentication

Environments:
  local
  dev
  live

Optional Arguments:
  --run-id <run-id>   Target a specific k6 run instead of defaulting to the latest completed run.

Examples:
  npm run loadtestresport -- --scenario homepage --env local
  npm run loadtestresport -- --scenario homepage --env dev --run-id 2026-09-02_115746_c88b78
`);
}

function fail(message: string): never {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

function localDateStamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function durationBetween(start: string | undefined, end: string | undefined): string {
  if (!start || !end) return 'N/A';
  const started = new Date(start).getTime();
  const completed = new Date(end).getTime();
  if (Number.isNaN(started) || Number.isNaN(completed) || completed < started) {
    return 'N/A';
  }
  const seconds = Math.round((completed - started) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  if (minutes === 0) {
    return `${remain}s`;
  }
  return `${minutes}m ${remain}s`;
}

// Main execution block
async function main() {
  const scenarioArg = getArgument('--scenario');
  const envArg = getArgument('--env');
  const runIdArg = getArgument('--run-id');

  if (!scenarioArg || !envArg) {
    printUsage();
    fail('Missing required arguments: --scenario and --env are both required.');
  }

  if (!validScenarios.includes(scenarioArg as Scenario)) {
    fail(`Invalid scenario "${scenarioArg}". Allowed values: ${validScenarios.join(', ')}`);
  }

  if (!isTestEnvironment(envArg)) {
    fail(`Invalid environment "${envArg}". Allowed values: ${testEnvironments.join(', ')}`);
  }

  const selectedScenario = scenarioArg as Scenario;
  const selectedEnvironment = envArg as TestEnvironment;

  const sourceDirectory = path.resolve(
    `scenarios/${selectedScenario}/reports/k6/${selectedEnvironment}`
  );

  let directoryEntries;
  try {
    directoryEntries = await readdir(sourceDirectory, {
      withFileTypes: true,
    });
  } catch {
    fail(`Could not find k6 reports directory:
- Scenario        : ${selectedScenario}
- Environment     : ${selectedEnvironment}
- Searched Path   : ${sourceDirectory}
- Expected Data   : Chronological run folders containing metadata.json and summary.json

How to resolve:
Run a k6 performance test first for this scenario and environment, e.g.:
  npm run k6:runner -- --scenario ${selectedScenario} --env ${selectedEnvironment} --profile smoke`);
  }

  // Filter for valid chronologically named run folders (format: YYYY-MM-DD_HHMMSS_xxxxxx)
  const runDirectories = directoryEntries.filter(
    (entry) => entry.isDirectory() && entry.name !== 'pdf' && /^\d{4}-\d{2}-\d{2}/.test(entry.name)
  );

  if (runDirectories.length === 0) {
    fail(`No k6 run directories found in search path:
- Scenario        : ${selectedScenario}
- Environment     : ${selectedEnvironment}
- Searched Path   : ${sourceDirectory}
- Expected Data   : Chronological run folders (like YYYY-MM-DD_HHMMSS_xxxxxx)

How to resolve:
Run a k6 performance test first to generate run folders and telemetry, e.g.:
  npm run k6:runner -- --scenario ${selectedScenario} --env ${selectedEnvironment} --profile smoke`);
  }

  // Sort them ascending lexicographically. The newest runs will be at the end of the list.
  runDirectories.sort((a, b) => a.name.localeCompare(b.name));

  let primaryRunMetadata: ReportMetadata | null = null;
  let primaryRunSummary: any = null;
  let primaryRunId = '';

  if (runIdArg) {
    // Load a specific requested Run ID
    const runPath = path.join(sourceDirectory, runIdArg);
    const metadataPath = path.join(runPath, 'metadata.json');
    const summaryPath = path.join(runPath, 'summary.json');

    try {
      const metadataText = await readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(metadataText) as ReportMetadata;

      const summaryText = await readFile(summaryPath, 'utf8');
      const summary = JSON.parse(summaryText);

      primaryRunMetadata = metadata;
      primaryRunSummary = summary;
      primaryRunId = runIdArg;
    } catch {
      // Gather completed runs as friendly suggestions for the error message
      const suggestions: string[] = [];
      for (const entry of runDirectories) {
        const checkPath = path.join(sourceDirectory, entry.name);
        try {
          await readFile(path.join(checkPath, 'metadata.json'), 'utf8');
          await readFile(path.join(checkPath, 'summary.json'), 'utf8');
          suggestions.push(entry.name);
        } catch {
          // ignore incomplete folders
        }
      }

      const suggestionStr = suggestions.length > 0
        ? `\nAvailable completed Run IDs in this directory:\n${suggestions.slice(-5).reverse().map(id => `  - ${id}`).join('\n')}`
        : '\nNo completed Run IDs were found in this directory.';

      fail(`Could not locate or parse the requested k6 run:
- Scenario        : ${selectedScenario}
- Environment     : ${selectedEnvironment}
- Requested Run ID: ${runIdArg}
- Searched Path   : ${runPath}
- Expected Data   : Both metadata.json and summary.json files for this specific run ID
${suggestionStr}

How to resolve:
Please ensure that the provided Run ID is correct, or omit --run-id to automatically use the latest completed run.`);
    }
  } else {
    // Fall back to latest-run behavior as default
    // Scan backwards starting from the most recent run to locate the newest completed run
    for (let i = runDirectories.length - 1; i >= 0; i--) {
      const dirName = runDirectories[i].name;
      const runPath = path.join(sourceDirectory, dirName);
      const metadataPath = path.join(runPath, 'metadata.json');
      const summaryPath = path.join(runPath, 'summary.json');

      try {
        const metadataText = await readFile(metadataPath, 'utf8');
        const metadata = JSON.parse(metadataText) as ReportMetadata;

        // Skip folders that represent active running tests
        if (metadata.status === 'running') {
          continue;
        }

        const summaryText = await readFile(summaryPath, 'utf8');
        const summary = JSON.parse(summaryText);

        primaryRunMetadata = metadata;
        primaryRunSummary = summary;
        primaryRunId = dirName;
        break; // Found the latest completed run, stop searching
      } catch {
        // Ignore reading or malformed errors and continue searching
        continue;
      }
    }

    if (!primaryRunMetadata || !primaryRunSummary) {
      fail(`Could not locate any completed k6 run under:
- Scenario        : ${selectedScenario}
- Environment     : ${selectedEnvironment}
- Searched Path   : ${sourceDirectory}
- Expected Data   : At least one run folder containing a valid metadata.json (with completed status) and summary.json

How to resolve:
Make sure a k6 performance test has completed execution successfully first, e.g.:
  npm run k6:runner -- --scenario ${selectedScenario} --env ${selectedEnvironment} --profile smoke`);
    }
  }

  // Metric extraction with safety defaults (N/A boundaries)
  const metrics = primaryRunSummary.metrics ?? {};
  
  // Concurrency & duration
  const vusMax = metrics.vus_max?.max ?? metrics.vus_max?.value ?? 0;
  const startedAt = primaryRunMetadata.startedAt;
  const completedAt = primaryRunMetadata.completedAt ?? new Date().toISOString();
  const durationStr = durationBetween(startedAt, completedAt);

  // Request stats
  const totalRequests = metrics.http_reqs?.count ?? 0;
  const rps = metrics.http_reqs?.rate ?? 0;

  // Failure and error rate calculations
  const failedRequests = metrics.http_req_failed?.passes ?? 0;
  const successfulRequests = Math.max(totalRequests - failedRequests, 0);
  const httpFailureRate = metrics.http_req_failed?.value ?? (totalRequests > 0 ? failedRequests / totalRequests : 0);

  // Checks mapping
  const checksMetrics = metrics.checks ?? {};
  const checksPassed = checksMetrics.passes ?? 0;
  const checksFailed = checksMetrics.fails ?? 0;
  const checksTotal = checksPassed + checksFailed;
  const checkSuccessRate = checksMetrics.value ?? (checksTotal > 0 ? checksPassed / checksTotal : 1.0);

  // Performance latencies (HTTP request duration)
  const durationMetrics = metrics.http_req_duration ?? {};
  const avgResponseTime = durationMetrics.avg ?? 0;
  const minResponseTime = durationMetrics.min ?? 0;
  const maxResponseTime = durationMetrics.max ?? 0;
  const p90ResponseTime = durationMetrics['p(90)'] ?? 0;
  const p95ResponseTime = durationMetrics['p(95)'] ?? 0;
  const p99ResponseTime = durationMetrics['p(99)'] ?? 'N/A'; // If missing, keep as N/A

  // Bandwidth
  const dataReceivedBytes = metrics.data_received?.count ?? 0;
  const dataSentBytes = metrics.data_sent?.count ?? 0;

  // Parse SLAs / Threshold results
  const thresholds: ReportThreshold[] = [];
  const failureReasons: string[] = [];

  for (const [metricName, metric] of Object.entries(primaryRunSummary.metrics ?? {})) {
    const m = metric as any;
    if (m && m.thresholds) {
      for (const [expression, result] of Object.entries(m.thresholds)) {
        const failed =
          result === true ||
          (typeof result === 'object' &&
            result !== null &&
            'ok' in result &&
            (result as { ok?: unknown }).ok === false);

        thresholds.push({
          metric: metricName,
          expression,
          passed: !failed,
        });

        if (failed) {
          failureReasons.push(`SLA threshold limit crossed: ${metricName} (${expression})`);
        }
      }
    }
  }

  // Assess assertion failures
  if (checksFailed > 0) {
    failureReasons.push(`Functional assertion checks failed: ${checksFailed} check failures registered.`);
  }

  // Assess HTTP failures
  if (failedRequests > 0) {
    failureReasons.push(`Network connection drops: ${failedRequests} HTTP requests failed with error rates.`);
  }

  // Assess runner level exit status
  if (primaryRunMetadata.exitCode && primaryRunMetadata.exitCode !== 0) {
    failureReasons.push(`Process exited with non-zero code: ${primaryRunMetadata.exitCode}`);
  }

  const overallPass =
    primaryRunMetadata.status === 'passed' &&
    checksFailed === 0 &&
    failedRequests === 0 &&
    failureReasons.length === 0;

  const finalStatus = overallPass ? 'PASSED' : 'FAILED';

  // Construct target output paths
  const reportDate = localDateStamp();
  const generatedAt = new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');

  const outputDirectory = path.resolve(
    `scenarios/${selectedScenario}/k6/reports/${selectedEnvironment}/pdf/${reportDate}`
  );

  // Automatically create missing output directories
  await mkdir(outputDirectory, {
    recursive: true,
  });

  const htmlPath = path.join(outputDirectory, 'load_test.html');
  const pdfPath = path.join(outputDirectory, 'load_test.pdf');

  // Build high-polished HTML representation
  const html = buildLoadTestReportHtml({
    scenario: selectedScenario,
    environment: selectedEnvironment,
    generatedAt,
    reportDate,
    htmlPath,
    pdfPath,
    runId: primaryRunMetadata.runId,
    metadata: primaryRunMetadata,
    summary: primaryRunSummary,
    testType: 'Load Performance Run',
    testProfile: primaryRunMetadata.profile ?? 'smoke',
    startedAt,
    completedAt,
    durationStr,
    vusMax,
    totalRequests,
    rps,
    successfulRequests,
    failedRequests,
    httpFailureRate,
    checksTotal,
    checksPassed,
    checksFailed,
    checkSuccessRate,
    avgResponseTime,
    minResponseTime,
    maxResponseTime,
    p90ResponseTime,
    p95ResponseTime,
    p99ResponseTime,
    dataReceivedBytes,
    dataSentBytes,
    thresholds,
    finalStatus: finalStatus === 'PASSED' ? 'PASS' : 'FAIL',
    failureReasons,
  });

  await writeFile(htmlPath, html, 'utf8');

  const testProfileName = primaryRunMetadata.profile ?? 'smoke';

  console.log('\n========================================');
  console.log('   CalicoDesk k6 Load Test Report');
  console.log('========================================\n');
  console.log(`Scenario     : ${selectedScenario}`);
  console.log(`Environment  : ${selectedEnvironment}`);
  console.log(`Run ID       : ${primaryRunMetadata.runId}`);
  console.log(`Profile      : ${testProfileName}`);
  console.log(`Status       : ${finalStatus}`);
  if (failureReasons.length > 0) {
    console.log(`\nFail Reasons :`);
    failureReasons.forEach(r => console.log(`  - ${r}`));
  }
  console.log('\nGenerating report...\n');

  // Start headless browser render for printing PDF
  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const page = await browser.newPage();

    // Use pathToFileURL to resolve file system paths safely across operating systems (Windows support)
    await page.goto(pathToFileURL(htmlPath).href, {
      waitUntil: 'load',
    });

    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `
        <div style="font-size:8px;width:100%;padding:0 15mm;color:#64748b;display:flex;justify-content:space-between;font-family:system-ui,sans-serif;">
          <span>CalicoDesk Performance Verification Report - ${selectedScenario} (${selectedEnvironment})</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>
      `,
      margin: {
        top: '12mm',
        bottom: '16mm',
        left: '10mm',
        right: '10mm',
      },
    });
  } catch (error) {
    await browser.close();
    fail(
      error instanceof Error
        ? `HTML generated successfully, but PDF printing failed: ${error.message}\nHTML file: ${htmlPath}`
        : `HTML generated successfully, but PDF printing failed.\nHTML file: ${htmlPath}`
    );
  }

  await browser.close();

  // Construct standard relative output paths starting with scenarios/ for clean CLI rendering
  const relativeHtmlPath = `scenarios/${selectedScenario}/k6/reports/${selectedEnvironment}/pdf/${reportDate}/load_test.html`;
  const relativePdfPath = `scenarios/${selectedScenario}/k6/reports/${selectedEnvironment}/pdf/${reportDate}/load_test.pdf`;

  console.log('HTML Report:');
  console.log(relativeHtmlPath);
  console.log('\nPDF Report:');
  console.log(relativePdfPath);
  console.log('\nShow PDF Report:');
  console.log('start ',relativePdfPath);
  console.log('\n========================================');
  console.log('Report generation completed successfully.');
  console.log('========================================\n');
}

main().catch((err) => {
  console.error('\nFatal generator failure:');
  console.error(err);
  process.exit(1);
});
