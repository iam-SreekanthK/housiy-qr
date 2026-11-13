// Minimal, dependency-free stand-in for the community k6-summary text
// renderer. Kept local (no jslib.k6.io fetch) so this runs identically in
// an offline CI agent as it does on a laptop.

function fmt(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return 'n/a';
  return Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2);
}

export function textSummary(data /*, options */) {
  const lines = [];
  lines.push('');
  lines.push('=========================================');
  lines.push(' Housiy k6 Load Test - Summary');
  lines.push('=========================================');

  const metrics = data.metrics || {};
  const metricNames = Object.keys(metrics).sort();

  lines.push('');
  lines.push('-- Thresholds --');
  let anyThreshold = false;
  for (const name of metricNames) {
    const m = metrics[name];
    if (!m.thresholds) continue;
    anyThreshold = true;
    for (const [thName, result] of Object.entries(m.thresholds)) {
      lines.push(`  ${result.ok ? 'PASS' : 'FAIL'}  ${name} ${thName}`);
    }
  }
  if (!anyThreshold) lines.push('  (none configured)');

  lines.push('');
  lines.push('-- Key metrics --');
  for (const name of metricNames) {
    const m = metrics[name];
    if (m.type !== 'trend') continue;
    const v = m.values;
    lines.push(
      `  ${name.padEnd(28)} avg=${fmt(v.avg)}ms p95=${fmt(v['p(95)'])}ms p99=${fmt(v['p(99)'])}ms max=${fmt(v.max)}ms`
    );
  }

  const failed = metrics.http_req_failed;
  if (failed) {
    lines.push('');
    lines.push(`  http_req_failed rate: ${(failed.values.rate * 100).toFixed(2)}%`);
  }

  lines.push('');
  lines.push(`Full results: tests/load/results/summary.json, summary.html, junit.xml`);
  lines.push('=========================================');
  lines.push('');
  return lines.join('\n');
}
