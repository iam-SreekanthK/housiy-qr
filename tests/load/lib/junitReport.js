// Renders k6 threshold results as a JUnit-style XML file so Jenkins can
// publish them with junit(), sitting alongside the PHPUnit and Playwright
// result files in the same pipeline stage.

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function junitReport(data, scenario) {
  const metrics = data.metrics || {};
  const cases = [];
  let failures = 0;

  for (const name of Object.keys(metrics).sort()) {
    const m = metrics[name];
    if (!m.thresholds) continue;
    for (const [thName, result] of Object.entries(m.thresholds)) {
      const testName = `${name} ${thName}`;
      if (result.ok) {
        cases.push(`    <testcase classname="k6.${esc(scenario)}" name="${esc(testName)}" />`);
      } else {
        failures++;
        cases.push(
          `    <testcase classname="k6.${esc(scenario)}" name="${esc(testName)}">\n` +
          `      <failure message="Threshold breached">${esc(testName)} did not pass</failure>\n` +
          `    </testcase>`
        );
      }
    }
  }

  const total = cases.length;
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="housiy-k6-${esc(scenario)}" tests="${total}" failures="${failures}">
${cases.join('\n')}
</testsuite>
`;
}
