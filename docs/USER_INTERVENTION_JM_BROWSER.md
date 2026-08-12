# User Intervention — JM Browser Runtime

This document lists actions that require the operator tomorrow. JM is the **client-side**
browser/runtime. BLRO is the future **server-side** MCP/RAG/DB authority. Do not install browser
profiles or customer credentials on BLRO.

For one-time endpoint setup and its scripted readiness check, use
[JM Endpoint Installation and Run Guide](JM_ENDPOINT_INSTALL.md)
(`pnpm run jm:endpoint:doctor`). This document is the per-change-window checklist.

## Morning decisions and inputs

Provide or confirm:

1. The JM operating system and an absolute Chrome/Chromium executable path.
2. The project-scoped JM browser profile directory.
3. The customer console origin, VPN/jump-host route, and approved maintenance window.
4. The change ticket, rollback plan, approving actor, and action list.
5. How `SANGFOR_OPERATOR_APPROVAL_SECRET` is injected from the local secret manager.
6. Whether the target is `lab` or `production`.
7. For later BLRO design: tenant ID, project ID, identity provider, ACL owners, retention, and
   data residency requirements.

Do not send passwords, cookies, MFA codes, approval secrets, or profile archives in chat.

## Prepare a supported browser

From the repository root on a Playwright-supported JM host:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm exec playwright --version
```

Expected: install exits 0 and the version matches the repository dependency.

On a host where Playwright cannot install a browser, select an already installed compatible
Chrome/Chromium and set its absolute path:

```bash
export SANGFOR_CHROMIUM_PATH=/absolute/path/to/chrome
test -x "$SANGFOR_CHROMIUM_PATH"
```

Expected: `test` exits 0 with no output.

Verified workstation caveat: Playwright 1.60.0 refused its installer on
`ubuntu26.04-x64`. This workstation's cached revision 1228 worked when configured explicitly:

```bash
export SANGFOR_CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
test -x "$SANGFOR_CHROMIUM_PATH"
```

Do not assume that path exists on another JM. Do not use a revision mismatch in production
without completing the lab smoke below.

## Create and authenticate a JM profile

Use a dedicated profile per tenant/project. Do not reuse a personal browsing profile.

Open the browser in a separate foreground terminal:

```bash
mkdir -p "$HOME/.local/share/sangfor-jm/profiles/<tenant>-<project>"
"$SANGFOR_CHROMIUM_PATH" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.local/share/sangfor-jm/profiles/<tenant>-<project>"
```

Then, in that browser:

1. Connect the customer VPN or approved network route.
2. Navigate to the exact customer console origin.
3. Complete login, MFA, CAPTCHA, and customer banner acknowledgement manually.
4. Confirm the browser shows exactly one intended console page.
5. Leave the foreground browser running only for the approved session.

JM may keep cookies in this local profile. Cookies, `storageState`, authorization headers, and
CDP endpoints must never be put into a `BrowserExecutionPort` request or uploaded as BLRO data.

## Check network and loopback CDP

Replace the placeholders with the approved origin:

```bash
curl -kfsSI "https://<customer-console-origin>/" >/dev/null
curl -fsS "http://127.0.0.1:9333/json/list"
```

Expected:

- the console origin is reachable from JM;
- `/json/list` returns JSON;
- exactly one intended console page is open;
- CDP is bound to `127.0.0.1`, never a non-loopback interface.

Register the exact borrowed port/origin pair before any attach:

```bash
export SANGFOR_JM_CDP_PROFILES_JSON='[
  {
    "profileRef": "approved-console",
    "cdpPort": 9333,
    "expectedOrigin": "https://<customer-console-origin>"
  }
]'
```

An unregistered port, mismatched origin, or corrupt registry is refused before
JM connects or fills credentials. For `sangfor_console_capture_evidence`, use
port `9222` in the profile when relying on that tool's default.

If the console requires an authenticated page to answer, verify reachability in the prepared
browser instead of placing credentials in `curl`.

## Run the safe local mock smoke

Terminal 1:

```bash
pnpm run dev:mock-console
```

Wait for:

```text
Mock Sangfor Console listening on http://localhost:3400
```

Terminal 2:

```bash
pnpm exec tsx scripts/test-browser-port.ts \
  --scenario local-readback \
  --base-url http://127.0.0.1:3400/hci
```

If the default Playwright browser is unavailable, keep `SANGFOR_CHROMIUM_PATH` exported.

Expected JSON fields:

```json
{
  "status": "PASS",
  "readBack": "PASS",
  "restored": "PASS",
  "screenshot": "<absolute path ending in c4-screenshot.png>"
}
```

The mutation dispatch itself remains INDETERMINATE until read-back, so its displayed boolean is
not a success field. Stop if `readBack` or `restored` is not `PASS`.

Run the refusal check:

```bash
pnpm exec tsx scripts/test-browser-port.ts \
  --scenario bad-origin \
  --base-url http://127.0.0.1:3400/hci
```

Expected: `status:"REFUSED"`, `mutationAttempted:false`, and
`error.code:"SESSION_ORIGIN_MISMATCH"`.

## Enable a real customer action only for its window

These values are required for a non-dry-run action:

```bash
export SANGFOR_ALLOW_REAL_EXECUTION=true
export SANGFOR_OPERATOR_APPROVAL_SECRET='<inject from local secret manager>'
export SANGFOR_NONCE_STORE_PATH="$HOME/.local/state/sangfor-jm/approval-nonces.json"
```

For a production-mode session or **any non-loopback mutation target**, also:

```bash
export SANGFOR_ALLOW_PRODUCTION_EXECUTION=true
```

Every action approval must contain:

- `approvedBy`
- `changeTicketId`
- `rollbackPlanId`
- unique `nonce`
- short `expiresAt`
- HMAC token bound to the exact action type and target
- maintenance window when required

Approval is per action. A token for `type config-name` cannot authorize `click Apply`. Missing
secret, replayed nonce, wrong origin, ambiguous target, or expired approval must refuse before
dispatch.

Use production enablement only after the mock smoke and a reversible lab action both pass.
Do not treat click completion or HTTP 2xx as success. Require independent read-back PASS.

## Actions this agent cannot perform without you

- Customer VPN, jump-host, or private DNS access.
- Customer console credentials, SSO, MFA, CAPTCHA, or license acceptance.
- Creation or retrieval of the real approval HMAC secret.
- Selection of the real change ticket, rollback plan, approver, and maintenance window.
- Any irreversible or customer-facing production action.
- Confirmation of customer data residency, retention, tenant/project ACL, and identity-provider
  policy for future BLRO.
- Production BLRO database, object store, KMS, IdP, DNS, certificate, and network provisioning.

## Disable and clean up

After the approved operation:

1. Close the customer console and stop the foreground browser with `Ctrl+C`.
2. Stop the mock console with `Ctrl+C` if it is running.
3. Disable all execution flags and remove secrets from the shell:

```bash
unset SANGFOR_ALLOW_REAL_EXECUTION
unset SANGFOR_ALLOW_PRODUCTION_EXECUTION
unset SANGFOR_OPERATOR_APPROVAL_SECRET
unset SANGFOR_NONCE_STORE_PATH
unset SANGFOR_CHROMIUM_PATH
unset SANGFOR_JM_CDP_PROFILES_JSON
```

4. Confirm no JM listener or browser remains:

```bash
lsof -nP -iTCP:3400 -iTCP:9333 -sTCP:LISTEN
pgrep -a chrome
```

Expected: no output after both processes are intentionally stopped.

5. Keep an approved project profile only if the customer policy permits it. To revoke local
   access, sign out in the browser first, close it, then archive or delete the exact
   project-scoped directory under change control. Never delete an unconfirmed profile path.

Rollback here means restoring the previous software/configuration artifact and halting for human
review. The system does not automatically roll back a device after an uncertain mutation.
