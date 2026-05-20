import { access, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function loadJsonConfig(filePath = 'config.json') {
  if (!existsSync(filePath)) return {};

  return JSON.parse(readFileSync(filePath, 'utf8'));
}

const fileConfig = loadJsonConfig();

function setting(envName, jsonName) {
  return process.env[envName] || fileConfig[jsonName];
}

function logStatus(message) {
  console.error(message);
}

const config = {
  devtoolsEndpoint: setting('CHROME_DEVTOOLS_JSON', 'devtoolsEndpoint') || 'http://127.0.0.1:9222/json/list',
  portalOrigin: setting('PAYSLIP_PORTAL_ORIGIN', 'portalOrigin'),
  apiOrigin: setting('PAYSLIP_API_ORIGIN', 'apiOrigin'),
  tenant: setting('PAYSLIP_TENANT', 'tenant'),
  payrollId: setting('PAYSLIP_PAYROLL_ID', 'payrollId'),
  payRunId: setting('PAYSLIP_PAY_RUN_ID', 'payRunId'),
  accessTokenKey: setting('PAYSLIP_ACCESS_TOKEN_KEY', 'accessTokenKey'),
};

const envNames = {
  devtoolsEndpoint: 'CHROME_DEVTOOLS_JSON',
  portalOrigin: 'PAYSLIP_PORTAL_ORIGIN',
  apiOrigin: 'PAYSLIP_API_ORIGIN',
  tenant: 'PAYSLIP_TENANT',
  payrollId: 'PAYSLIP_PAYROLL_ID',
  payRunId: 'PAYSLIP_PAY_RUN_ID',
  accessTokenKey: 'PAYSLIP_ACCESS_TOKEN_KEY',
};

function missingConfig(...keys) {
  return keys.filter(key => !config[key]);
}

function assertConfig(...keys) {
  const missing = missingConfig(...keys);
  if (missing.length) {
    throw new Error(`Missing required configuration values: ${missing.map(key => envNames[key]).join(', ')}`);
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();

    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;

      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);

      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws.close();
  }
}

async function pageTarget() {
  const targets = await fetch(config.devtoolsEndpoint).then((response) => response.json());
  const pages = Array.isArray(targets) ? targets : targets.value;
  const pageTargets = pages.filter((target) => target.type === 'page' && /^https?:\/\//.test(target.url || ''));
  const page = config.portalOrigin
    ? pageTargets.find((target) => target.url.startsWith(config.portalOrigin))
    : pageTargets.find((target) => !target.url.includes('/portal')) || pageTargets[0];

  if (!page && config.portalOrigin) {
    throw new Error(`No matching portal page target found for ${config.portalOrigin}.`);
  }
  if (!page) {
    throw new Error('No HTTP(S) portal page target found. Open the payslip portal in Chrome first.');
  }
  return page;
}

async function evaluate(expression) {
  const target = await pageTarget();
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  cdp.close();

  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails, null, 2));
  }

  return result.result.value;
}

function isoDate(value) {
  return String(value || '').slice(0, 10);
}

function portalLocalDateTime(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}+${date.getHours()}:${date.getMinutes()}`;
}

function safeFilePart(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractConfigFromSnapshot(snapshot) {
  const discovered = {};
  const locationUrl = new URL(snapshot.location.href);
  const pathParts = locationUrl.pathname.split('/').filter(Boolean);

  discovered.portalOrigin = locationUrl.origin;
  discovered.tenant = pathParts[0];

  const tokenEntry = snapshot.sessionStorage.find((entry) =>
    /access.*token/i.test(entry.key) && entry.valueLength > 20
  ) || snapshot.sessionStorage.find((entry) =>
    /token/i.test(entry.key) && entry.valueLength > 20
  );
  if (tokenEntry) discovered.accessTokenKey = tokenEntry.key;

  const payslipPath = locationUrl.pathname.match(new RegExp(`^/${pathParts[0] || '[^/]+'}/payslips/([^/]+)/`));
  if (payslipPath) discovered.payRunId = payslipPath[1];

  for (const resourceUrl of snapshot.resourceUrls) {
    let url;
    try {
      url = new URL(resourceUrl);
    } catch {
      continue;
    }

    const paydatesMatch = url.pathname.match(/^\/api\/([^/]+)\/payroll\/([^/]+)\/paydates\/([^/]+)/);
    if (paydatesMatch) {
      discovered.apiOrigin = url.origin;
      discovered.tenant = paydatesMatch[1];
      discovered.payrollId = paydatesMatch[2];
      discovered.payRunId = paydatesMatch[3];
      continue;
    }

    const payslipsMatch = url.pathname.match(/^\/api\/([^/]+)\/payslips\/([^/]+)\/([^/]+)/);
    if (payslipsMatch) {
      discovered.apiOrigin = url.origin;
      discovered.tenant = payslipsMatch[1];
      discovered.payrollId = payslipsMatch[2];
      discovered.payRunId = payslipsMatch[3];
      continue;
    }

    const payrollMatch = url.pathname.match(/^\/api\/([^/]+)\/payroll\/([^/]+)/);
    if (payrollMatch) {
      discovered.apiOrigin = url.origin;
      discovered.tenant = payrollMatch[1];
      discovered.payrollId = payrollMatch[2];
    }
  }

  return discovered;
}

function mergeDiscoveredConfig(discovered) {
  for (const [key, value] of Object.entries(discovered)) {
    if (!config[key] && value) config[key] = value;
  }
}

async function snapshotPortalPage() {
  return evaluate(`(() => ({
    location: {
      href: location.href,
      origin: location.origin,
      pathname: location.pathname
    },
    sessionStorage: Array.from({ length: sessionStorage.length }, (_, index) => {
      const key = sessionStorage.key(index);
      const value = sessionStorage.getItem(key) || '';
      return { key, valueLength: value.length };
    }),
    resourceUrls: performance.getEntriesByType('resource').map((entry) => entry.name)
  }))()`);
}

async function discoverConfig() {
  mergeDiscoveredConfig(extractConfigFromSnapshot(await snapshotPortalPage()));

  if (missingConfig('apiOrigin', 'payrollId', 'payRunId').length && config.portalOrigin && config.tenant) {
    const payslipsUrl = `${config.portalOrigin.replace(/\/$/, '')}/${config.tenant}/payslips/`;
    await evaluate(`location.href=${JSON.stringify(payslipsUrl)}; 'navigating'`);
    await new Promise(resolve => setTimeout(resolve, 4000));
    mergeDiscoveredConfig(extractConfigFromSnapshot(await snapshotPortalPage()));
  }

  assertConfig('portalOrigin', 'apiOrigin', 'tenant', 'payrollId', 'payRunId', 'accessTokenKey');
  return config;
}

async function getPortalState() {
  await discoverConfig();
  return evaluate(`(() => ({
    accessToken: sessionStorage.getItem(${JSON.stringify(config.accessTokenKey)}),
    origin: location.origin,
    company: ${JSON.stringify(config.tenant)},
    payrollId: ${JSON.stringify(config.payrollId)},
    payRunId: ${JSON.stringify(config.payRunId)}
  }))()`);
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.json();
}

async function loadPdfBase64FromView(viewUrl, timeoutMs = 30000) {
  await evaluate(`location.href=${JSON.stringify(viewUrl)}; 'navigating'`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 700));
    const result = await evaluate(`(() => {
      const scopes = [...document.querySelectorAll('*')]
        .map(element => window.angular && angular.element(element).scope && angular.element(element).scope())
        .filter(Boolean);
      const value = scopes.map(scope => scope.payslipfile)
        .find(item => typeof item === 'string' && item.startsWith('JVBER'));
      const failed = scopes.map(scope => scope.payslipFailedMessage).find(Boolean);
      return {
        url: location.href,
        found: !!value,
        value: value || null,
        failed: failed || null,
        loading: document.body.innerText.includes('Loading')
      };
    })()`);

    if (result?.found) return result.value;
    if (result?.failed && !result.loading) {
      throw new Error(`Portal failed to load PDF at ${viewUrl}: ${result.failed}`);
    }
  }

  throw new Error(`Timed out waiting for PDF data at ${viewUrl}`);
}

async function getManifest({ verbose = false } = {}) {
  await discoverConfig();
  const state = await getPortalState();
  if (!state.accessToken) {
    throw new Error('No portal access token found in the active browser session.');
  }

  const apiBase = `${config.apiOrigin.replace(/\/$/, '')}/api/${state.company}`;
  const paydatesUrl = `${apiBase}/payroll/${state.payrollId}/paydates/${state.payRunId}?count=500&localdatetime=${portalLocalDateTime()}`;
  if (verbose) logStatus('Fetching payslip manifest...');
  const paydates = await fetchJson(paydatesUrl, state.accessToken);
  const periods = paydates.payPeriodSummaries || [];
  const manifest = [];

  if (verbose) logStatus(`Found ${periods.length} pay periods. Fetching file lists...`);

  for (const [index, period] of periods.entries()) {
    const payDate = isoDate(period.payDate);
    if (verbose) logStatus(`Fetching files for ${payDate} (${index + 1}/${periods.length})...`);
    const detailUrl = `${apiBase}/payslips/${state.payrollId}/${state.payRunId}/${period.payPeriodId}`;
    const detail = await fetchJson(detailUrl, state.accessToken);
    const rows = detail.payslipSummaries || [];
    const files = [];

    for (const row of rows) {
      for (const file of row.files || []) {
        files.push({
          payslipId: row.payslipId,
          payslipName: row.payslipName,
          payslipFileId: file.payslipFileId,
          originalFileName: file.payslipFileName,
          viewUrl: `${state.origin}/${state.company}/payslips/${state.payRunId}/${period.payPeriodId}/file/${row.payslipId}/${file.payslipFileId}/`,
        });
      }
    }

    manifest.push({
      payPeriodId: period.payPeriodId,
      payDate,
      startDate: isoDate(period.startDate),
      endDate: isoDate(period.endDate),
      files,
    });
  }

  if (verbose) {
    const fileCount = manifest.reduce((total, detail) => total + detail.files.length, 0);
    logStatus(`Manifest ready: ${manifest.length} pay periods, ${fileCount} files.`);
  }

  return { state: { ...state, accessToken: undefined }, manifest };
}

const command = process.argv[2] || 'scan';

if (command === 'config') {
  await discoverConfig();
  console.log(JSON.stringify({
    devtoolsEndpoint: config.devtoolsEndpoint,
    portalOrigin: config.portalOrigin,
    apiOrigin: config.apiOrigin,
    tenant: config.tenant,
    payrollId: config.payrollId,
    payRunId: config.payRunId,
    accessTokenKey: config.accessTokenKey,
  }, null, 2));
} else if (command === 'scan') {
  const scan = await getManifest({ verbose: true });
  const details = scan.manifest;

  const summary = {
    detailCount: details.length,
    fileCount: details.reduce((total, detail) => total + detail.files.length, 0),
    multiFileDates: details.filter(detail => detail.files.length > 1).map(detail => ({
      payDate: detail.payDate,
      period: `${detail.startDate} to ${detail.endDate}`,
      files: detail.files.length,
    })),
    missingFileDates: details.filter(detail => detail.files.length === 0).map(detail => detail.payDate),
  };

  console.log(JSON.stringify(summary, null, 2));
} else if (command === 'manifest') {
  const scan = await getManifest({ verbose: true });
  console.log(JSON.stringify(scan.manifest, null, 2));
} else if (command === 'testdownload') {
  const scan = await getManifest({ verbose: true });
  const first = scan.manifest.flatMap(period => period.files.map(file => ({ period, file })))[0];
  logStatus(`Downloading test file ${first.period.payDate} ${first.file.originalFileName}...`);
  const base64 = await loadPdfBase64FromView(first.file.viewUrl);
  const bytes = Buffer.from(base64, 'base64');
  logStatus(`Downloading test file ${first.period.payDate} ${first.file.originalFileName}... done (${bytes.length} bytes)`);
  console.log(JSON.stringify({
    payDate: first.period.payDate,
    originalFileName: first.file.originalFileName,
    bytes: bytes.length,
    signature: bytes.subarray(0, 5).toString('ascii'),
  }, null, 2));
} else if (command === 'download') {
  const scan = await getManifest({ verbose: true });
  const outDir = path.resolve(process.argv[3] || 'payslips-downloads');
  const allFiles = scan.manifest.flatMap(period => period.files.map(file => ({ period, file })));
  const results = [];

  await mkdir(outDir, { recursive: true });
  logStatus(`Downloading missing files into ${outDir}`);

  for (const [index, item] of allFiles.entries()) {
    const { period, file } = item;
    const suffix = period.files.length > 1 ? `-${file.payslipName || index + 1}-${file.payslipFileId}` : '';
    const baseName = `${period.payDate}_${period.startDate}_to_${period.endDate}${suffix}_${safeFilePart(file.originalFileName || 'payslip.pdf')}`;
    const filePath = path.join(outDir, baseName.endsWith('.pdf') ? baseName : `${baseName}.pdf`);

    try {
      await access(filePath);
      logStatus(`Skipping ${period.payDate} ${index + 1}/${allFiles.length} ${file.originalFileName} (already exists)`);
      results.push({ filePath, bytes: 0, skipped: true });
      continue;
    } catch {
      // File does not exist yet.
    }

    logStatus(`Downloading ${period.payDate} ${index + 1}/${allFiles.length} ${file.originalFileName}...`);
    const base64 = await loadPdfBase64FromView(file.viewUrl);
    const bytes = Buffer.from(base64, 'base64');

    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error(`Download failed for ${period.payDate} file ${file.payslipFileId}: decoded data was not a PDF`);
    }

    await writeFile(filePath, bytes);
    results.push({ filePath, bytes: bytes.length });
    logStatus(`Downloading ${period.payDate} ${index + 1}/${allFiles.length} ${file.originalFileName}... done (${bytes.length} bytes)`);
  }

  console.log(JSON.stringify({
    outDir,
    downloaded: results.filter(result => !result.skipped).length,
    skipped: results.filter(result => result.skipped).length,
    totalBytes: results.reduce((sum, result) => sum + result.bytes, 0),
  }, null, 2));
} else if (command === 'verify') {
  const scan = await getManifest({ verbose: true });
  const outDir = path.resolve(process.argv[3] || process.argv[2] || 'payslips-downloads');
  logStatus(`Verifying files in ${outDir}...`);
  const expected = scan.manifest.flatMap(period => period.files.map((file, index) => {
    const suffix = period.files.length > 1 ? `-${file.payslipName || index + 1}-${file.payslipFileId}` : '';
    const baseName = `${period.payDate}_${period.startDate}_to_${period.endDate}${suffix}_${safeFilePart(file.originalFileName || 'payslip.pdf')}`;
    return path.join(outDir, baseName.endsWith('.pdf') ? baseName : `${baseName}.pdf`);
  }));
  const missing = expected.filter(filePath => !existsSync(filePath));
  logStatus(`Verification complete: ${expected.length - missing.length}/${expected.length} present.`);
  console.log(JSON.stringify({
    outDir,
    expected: expected.length,
    present: expected.length - missing.length,
    missing,
  }, null, 2));
} else {
  throw new Error(`Unknown command: ${command}`);
}
