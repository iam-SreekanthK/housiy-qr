// Small, dependency-free HTML report. No external CSS/JS/fonts are
// fetched, so this renders identically whether opened from a laptop or
// archived as a Jenkins build artifact with no internet access.

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmt(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return 'n/a';
  return Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2);
}

export function htmlReport(data, scenario, baseUrl) {
  const metrics = data.metrics || {};
  const metricNames = Object.keys(metrics).sort();

  const thresholdRows = [];
  for (const name of metricNames) {
    const m = metrics[name];
    if (!m.thresholds) continue;
    for (const [thName, result] of Object.entries(m.thresholds)) {
      thresholdRows.push(
        `<tr class="${result.ok ? 'pass' : 'fail'}"><td>${esc(name)}</td><td>${esc(thName)}</td><td>${result.ok ? 'PASS' : 'FAIL'}</td></tr>`
      );
    }
  }

  const trendRows = [];
  for (const name of metricNames) {
    const m = metrics[name];
    if (m.type !== 'trend') continue;
    const v = m.values;
    trendRows.push(
      `<tr><td>${esc(name)}</td><td>${fmt(v.avg)}</td><td>${fmt(v.med)}</td><td>${fmt(v['p(90)'])}</td><td>${fmt(v['p(95)'])}</td><td>${fmt(v['p(99)'])}</td><td>${fmt(v.max)}</td></tr>`
    );
  }

  const countRows = [];
  for (const name of metricNames) {
    const m = metrics[name];
    if (m.type !== 'counter') continue;
    countRows.push(`<tr><td>${esc(name)}</td><td>${fmt(m.values.count)}</td></tr>`);
  }

  const failedRate = metrics.http_req_failed ? (metrics.http_req_failed.values.rate * 100).toFixed(2) : 'n/a';
  const durationMs = data.state && data.state.testRunDurationMs ? (data.state.testRunDurationMs / 1000).toFixed(1) : 'n/a';
  const overallPass = thresholdRows.every((r) => r.includes('pass'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Housiy k6 Load Test Report</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 2rem; background: #0f1220; color: #e8e8f0; }
  h1 { margin-bottom: 0.2rem; }
  .meta { color: #9aa0b4; margin-bottom: 1.5rem; }
  .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 999px; font-weight: 600; font-size: 0.85rem; }
  .badge.pass { background: #16532b; color: #b8f0c8; }
  .badge.fail { background: #5a1a1a; color: #f5b8b8; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; background: #171a2b; }
  th, td { padding: 0.5rem 0.8rem; border-bottom: 1px solid #2a2e45; text-align: left; font-size: 0.9rem; }
  th { color: #9aa0b4; font-weight: 600; }
  tr.pass td:nth-child(3) { color: #7be89a; font-weight: 600; }
  tr.fail td:nth-child(3) { color: #f18a8a; font-weight: 600; }
  h2 { margin-top: 2rem; border-bottom: 2px solid #2a2e45; padding-bottom: 0.4rem; }
</style>
</head>
<body>
  <h1>Housiy Load Test Report</h1>
  <div class="meta">
    Scenario: <strong>${esc(scenario)}</strong> &middot;
    Target: <strong>${esc(baseUrl)}</strong> &middot;
    Duration: <strong>${durationMs}s</strong> &middot;
    HTTP error rate: <strong>${failedRate}%</strong> &middot;
    <span class="badge ${overallPass ? 'pass' : 'fail'}">${overallPass ? 'ALL THRESHOLDS PASSED' : 'THRESHOLD FAILURES'}</span>
  </div>

  <h2>Thresholds</h2>
  <table>
    <tr><th>Metric</th><th>Threshold</th><th>Result</th></tr>
    ${thresholdRows.join('\n    ') || '<tr><td colspan="3">No thresholds configured</td></tr>'}
  </table>

  <h2>Latency (ms) by endpoint</h2>
  <table>
    <tr><th>Metric</th><th>avg</th><th>med</th><th>p90</th><th>p95</th><th>p99</th><th>max</th></tr>
    ${trendRows.join('\n    ')}
  </table>

  <h2>Counters</h2>
  <table>
    <tr><th>Metric</th><th>Count</th></tr>
    ${countRows.join('\n    ')}
  </table>
</body>
</html>`;
}
