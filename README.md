# Payslip Downloader Helper

This folder contains a small helper for downloading payslip PDFs from an already signed-in Chrome session.

The main script is:

```powershell
.\payslip-tools.mjs
```

It uses Chrome DevTools remote debugging on `http://127.0.0.1:9222` to read the active browser session, then calls the portal API to discover payslip files. For each file, it opens the portal's own payslip viewer route, waits for the PDF data the app renders, decodes it, and writes it as a local `.pdf`.

## Files

`payslip-tools.mjs`

The main payslip automation script. Use this for scanning, downloading, resuming, verifying, and testing the payslip download flow.

`payslips-downloads\`

The output folder containing downloaded payslip PDFs. Rerunning the downloader against this folder skips files that already exist.

## Configuration

If the payslip portal is already loaded in Chrome, the script can usually discover its configuration automatically from the active tab:

```powershell
node .\payslip-tools.mjs config
```

That command prints the discovered portal origin, API origin, tenant, payroll id, pay-run id, Session Storage token key, and paydate count. It does not print the access token value.

You can write the discovered values directly to local config:

```powershell
node .\payslip-tools.mjs config > config.json
```

Use `config.json` when you want to pin or override discovered values:

```json
{
  "devtoolsEndpoint": "http://127.0.0.1:9222/json/list",
  "portalOrigin": "https://your-portal.example.com",
  "apiOrigin": "https://your-api.example.com",
  "tenant": "your-tenant",
  "payrollId": "your-payroll-id",
  "payRunId": "your-pay-run-id",
  "accessTokenKey": "your-session-storage-access-token-key",
  "paydateCount": 26,
  "outputDir": "C:\\path\\to\\paystubs"
}
```

The script reads `config.json` automatically if it exists. Shell environment variables still work and override `config.json`; both override auto-discovery. Do not commit `config.json`; it is ignored by Git.

By default, the script asks the portal for the 26 most recent pay periods. Override that with `paydateCount` in `config.json`, `PAYSLIP_PAYDATE_COUNT`, or a CLI flag such as `--count 52`.

By default, downloads are written to `payslips-downloads`. Set `outputDir` in `config.json` or `PAYSLIP_OUTPUT_DIR` to change the default. A command-line output directory still takes precedence for `download` and `verify`.

### Finding Config Values Manually

Most of these values can be discovered by running:

```powershell
node .\payslip-tools.mjs config
```

If auto-discovery fails, use the manual steps below.

`portalOrigin`

Open the payslips page in Chrome. Use the origin from the address bar, for example `https://your-portal.example.com`. Do not include the path.

`apiOrigin`

Open Chrome DevTools on the portal page, then check the Network tab while the payslips page loads. Look for API requests that return pay periods or payslip details. Use the origin from those requests, for example `https://your-api.example.com`. Do not include `/api/...`.

`tenant`

Look at the payslip page URL path. In many portals it is the first path segment after the host:

```text
https://your-portal.example.com/<tenant>/payslips/
```

`payrollId`

In the Network tab, look for a request shaped like:

```text
/api/<tenant>/payroll/<payroll-id>/paydates/...
```

Use the numeric value in the `<payroll-id>` position.

`payRunId`

Open any individual payslip detail page. The URL is usually shaped like:

```text
https://your-portal.example.com/<tenant>/payslips/<pay-run-id>/<pay-period-id>/
```

Use the UUID-looking value in the `<pay-run-id>` position. This value appears to identify the payroll stream rather than the login session, but if the portal changes later, copy the current value from a fresh payslip URL.

`accessTokenKey`

Open DevTools on the portal page and inspect Session Storage for the portal origin. Use the key that stores the API access token. The script reads the token value at runtime and does not write it to disk.

## Requirements

1. Chrome must be running with remote debugging enabled on port `9222`.
2. You must be signed into the portal in that Chrome session.
3. The portal tab should be open on the payslip portal or a payslip page.

If the session expires, open the payslips page in Chrome again and let SSO refresh the login before rerunning the script.

## Starting Chrome

One option is to start a persistent MCP/debug profile:

```powershell
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=$env:LOCALAPPDATA\Google\Chrome-MCP-Profile"
```

Then sign into the portal in that Chrome window.

If you are using Chrome's active-session DevTools MCP support instead, make sure the browser is already reachable at:

```text
http://127.0.0.1:9222/json/list
```

## Commands

Status/progress messages are written to stderr. JSON results are written to stdout, so redirects like `node .\payslip-tools.mjs config > config.json` stay clean.

Scan the portal and summarize available payslip files:

```powershell
node .\payslip-tools.mjs scan
```

Show discovered configuration:

```powershell
node .\payslip-tools.mjs config
```

Fetch more or fewer pay periods:

```powershell
node .\payslip-tools.mjs scan --count 52
node .\payslip-tools.mjs download --count 52
```

Download all missing payslip PDFs into the configured output directory:

```powershell
node .\payslip-tools.mjs download
```

Verify the local folder against the portal manifest:

```powershell
node .\payslip-tools.mjs verify
```

Test one PDF download path:

```powershell
node .\payslip-tools.mjs testdownload
```

Print the full discovered manifest:

```powershell
node .\payslip-tools.mjs manifest
```

## Resume Behavior

The downloader is resumable. It builds the expected filename for each portal file and skips any PDF that already exists in the output folder.

That means rerunning:

```powershell
node .\payslip-tools.mjs download
```

will only download files that are new or missing. Existing files are not overwritten.

## Output Naming

Files are named with the pay date, pay period, and original portal filename:

```text
YYYY-MM-DD_YYYY-MM-DD_to_YYYY-MM-DD_original-name.pdf
```

For pay periods with multiple files, the script also includes the payslip/file identifiers so the files do not overwrite each other:

```text
YYYY-MM-DD_YYYY-MM-DD_to_YYYY-MM-DD-<payslipName>-<fileId>_original-name.pdf
```

## Notes

- The script reads the access token from the active portal tab's `sessionStorage`; it does not write the token to disk.
- Downloaded PDFs are ignored by Git via `.gitignore`.
- Keep remote debugging enabled only while you need it.
- If the portal UI changes, rerun `scan` first to confirm the manifest can still be read.
