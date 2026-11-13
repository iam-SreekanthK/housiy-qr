'use strict';
// Static contract: Nginx must re-resolve the Docker realtime service quickly after restart.
const fs = require('fs');
const path = require('path');
const config = fs.readFileSync(path.join(__dirname, '../../deployment/docker/nginx/app.conf'), 'utf8');
const checks = [
  [/location = \/ws[\s\S]*?resolver 127\.0\.0\.11 valid=1s ipv6=off;/, 'WebSocket upstream uses Docker DNS with a short re-resolution TTL'],
  [/location = \/ws[\s\S]*?resolver_timeout 2s;/, 'DNS lookup has a bounded timeout'],
  [/location = \/ws[\s\S]*?set \$realtime_upstream realtime:8090;[\s\S]*?proxy_pass http:\/\/\$realtime_upstream;/, 'WebSocket upstream is resolved dynamically instead of at Nginx startup'],
  [/location = \/ws[\s\S]*?proxy_http_version 1\.1;[\s\S]*?proxy_set_header Upgrade \$http_upgrade;/, 'WebSocket upgrade headers are preserved'],
];
let failed = 0;
for (const [pattern, label] of checks) { const ok = pattern.test(config); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failed++; }
process.exit(failed ? 1 : 0);
