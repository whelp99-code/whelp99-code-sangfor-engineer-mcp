---
name: "itac-console-login"
description: "Log in to the ITAC group Sangfor/FortiGate consoles (SCP, IAG, Cyber Command, Athena EPP, FortiGate) from Linux using the agent-browser CLI. Activate when the user asks for ITAC 탭 로그인, 이 그룹 탭 모두 로그인, IljiTech 콘솔 로그인, or SCP/IAG/EPP/CC/FortiGate 일괄 로그인. Login only — never change settings."
---

# ITAC console bulk login (agent-browser port)

Linux port of the macOS Aside skill `itac-console-login`
(`/Users/jmpark/.aside/u/0/skills/user/itac-console-login/SKILL.md`).
Goal is unchanged: **log in only.** No config change, no inspection, no screen collection.

> **Status: syntax-verified, live-unproven.** Every command below uses verbs confirmed
> against `agent-browser 0.34.0` on this machine. The flow has NOT been executed against the
> real ITAC devices. Treat first live run as a shakedown and fix selectors in place.

## Speed rules — never do these

Carried over from the Aside skill; each cost real time before.

- **Apple Passwords**, Touch ID, browser autofill, Aside Password Manager — none exist here
  and none may be substituted. Credentials come only from the agent-browser auth vault (below).
- Notion `listAccounts` / `getClient` — **no equivalent** on this host and both returned 403
  anyway. Do not reach for a Notion API.
- Do not search memory/history for where a password lives. The vault profile name is the answer.
- Never run `snapshot` on a credential page — passwords land in the accessibility tree and
  therefore in the model context.
- Never try `captcha.readText`-style helpers first; these consoles refuse them. Screenshot the
  CAPTCHA element and read the image.
- Never open the EULA / DPA modal on Cyber Command.
- Never insert any step between reading a CAPTCHA and submitting it.

Never write passwords, OTPs, or CAPTCHA text into chat, logs, files, or memory. Report only
host, product, username, and landing URL.

## Credentials: seed the vault once, then never see them again

This replaces the Aside "read the Notion table into a REPL variable" step. The Aside REPL kept
the value off-screen; a CLI would print it to stdout and into the model context, so use the
encrypted vault instead — the model never receives the secret.

One-time setup per console (run by a human, password typed into stdin, never pasted in chat):

```bash
export AGENT_BROWSER_ENCRYPTION_KEY=$(openssl rand -hex 32)   # persist this in your shell rc

read -rs PW && printf '%s' "$PW" | agent-browser auth save itac-scp \
  --url 'https://10.80.1.104:4430/login' --username admin --password-stdin
read -rs PW && printf '%s' "$PW" | agent-browser auth save itac-iag \
  --url 'https://10.80.1.108/login.php' --username admin --password-stdin
read -rs PW && printf '%s' "$PW" | agent-browser auth save itac-fgt \
  --url 'https://172.16.10.1/login' --username cisco --password-stdin \
  --username-selector '#username' --password-selector '#secretkey' --submit-selector '#login_button'
read -rs PW && printf '%s' "$PW" | agent-browser auth save itac-cc \
  --url 'https://10.80.1.107/ui/login/login.html' --username admin --password-stdin
read -rs PW && printf '%s' "$PW" | agent-browser auth save itac-epp \
  --url 'https://10.80.1.106/ui/login.php' --username admin --password-stdin
```

Source of truth for the values stays the Notion ITAC table
(`https://app.notion.com/p/VPN-3c0367013518813d9132cae5b62ab5a8`, tab `고객사 VPN 로그인`),
row shape `IP | 제품 | 설명 | username / password`. FortiGate rows marked `동일` reuse the
`172.16.10.1` credentials. SCP uses the Management WebUI row, EPP the EPP row, CC the NDR row,
IAG the IAG row.

Verify without exposing anything: `agent-browser auth list` (names and URLs only).

`auth login <name>` works for SCP, IAG and FortiGate. Cyber Command and Athena EPP need the
CAPTCHA flow below, so they fill fields explicitly.

## Targets

All consoles use self-signed certs — **every command needs `--ignore-https-errors`**.

| Host | Product | Vault profile | Note |
|---|---|---|---|
| `https://10.80.1.104:4430/login` | SCP Admin Portal | `itac-scp` | different from Self Service `https://10.80.1.104/login`; never retry this account there |
| `https://10.80.1.108/login.php` | IAG v13 | `itac-iag` | do not use `/ui/` |
| `https://10.80.1.107/ui/login/login.html` | Cyber Command | `itac-cc` | CAPTCHA |
| `https://10.80.1.106/ui/login.php` | Athena EPP | `itac-epp` | CAPTCHA; autofill forbidden |
| `https://172.16.10.1/login` | FortiGate ITAC_FW | `itac-fgt` | **one device**, 4 addresses |
| `https://172.16.20.1/login` | same device | — | port5 / OA_BB |
| `https://172.16.30.1/login` | same device | — | x3 / FA_BB |
| `https://172.16.40.1/` | same device | — | only if that tab exists |

Counting those four FortiGate addresses as four devices corrupts inventory. They are one box.

HCI `10.80.1.105` and STA `10.80.1.109` stay closed unless the user asks for that group.

### Tab-group scoping: no equivalent

Aside filtered by the Chrome tab group named `ITAC` via `chrome.tabGroups.query`, an extension
API. agent-browser drives CDP and **cannot see Chrome tab groups**. Substitute URL matching
against the table above, which is stricter anyway:

```bash
export SESSION=itac
agent-browser --session "$SESSION" --auto-connect tab list --json
```

Attach to an existing console tab by its `targetId` instead of opening a new one:

```bash
agent-browser --session "$SESSION" tab <targetId>
```

Skip any tab already past `/login`, plus chat tabs and `chrome-extension:` tabs.

## Order

SCP → IAG → FortiGate → Cyber Command → Athena EPP. CAPTCHA-free consoles finish first.

## Per console

### SCP Admin Portal

Click the visible **Log In** button; never submit the form programmatically.

```bash
agent-browser --session "$SESSION" --ignore-https-errors open 'https://10.80.1.104:4430/login'
agent-browser --session "$SESSION" auth login itac-scp
agent-browser --session "$SESSION" get url
agent-browser --session "$SESSION" get title
```

Success: URL `https://10.80.1.104:4430/` or `#/mod-home-overview`, header shows
`admin Super Admin`. Confirm with `agent-browser find text "Super Admin" text`.

### IAG

After the fields are filled, `Checking whether email verification is required...` appears and
Log In is briefly disabled. Wait for that message to clear before clicking — this is the whole
reason IAG used to be slow.

```bash
agent-browser --session "$SESSION" --ignore-https-errors open 'https://10.80.1.108/login.php'
agent-browser --session "$SESSION" find label "Username" fill admin
# password comes from the vault; if filling manually never echo it
agent-browser --session "$SESSION" wait --fn "!document.body.innerText.includes('Checking whether email verification')"
agent-browser --session "$SESSION" find role button click --name "Log In"
agent-browser --session "$SESSION" get title
```

Success: `https://10.80.1.108/index.php`, title `SANGFOR IAG`.

### FortiGate

The password field is missing from the accessibility tree, so use CSS selectors — that is why
the vault profile pins `#username` / `#secretkey` / `#login_button`. Never touch FortiCloud SSO.

```bash
agent-browser --session "$SESSION" --ignore-https-errors open 'https://172.16.10.1/login'
agent-browser --session "$SESSION" auth login itac-fgt
agent-browser --session "$SESSION" get url
```

If the `/prompt` Setup wizard appears, click **Later** only — no Begin, no password change, no
FortiCare registration:

```bash
agent-browser --session "$SESSION" find role button click --name "Later"
```

Success: title `FortiGate - ITAC_FW`, user `cisco`. The other three addresses are the same
device; do not log in again unless a tab for them is open and shows `/login`.

### Cyber Command

`screenshot <selector> <path>` clips a single element, so the CAPTCHA image is captured
directly. Read the 4 characters from the saved PNG, then fill and submit in one `batch` so
nothing comes between reading and submitting.

```bash
agent-browser --session "$SESSION" --ignore-https-errors open 'https://10.80.1.107/ui/login/login.html'
agent-browser --session "$SESSION" screenshot '.uedc-ppkg-login_captcha' /tmp/itac-cc-captcha.png
# read /tmp/itac-cc-captcha.png -> CODE
agent-browser --session "$SESSION" batch --bail \
  "find label Username fill admin" \
  "fill input[type=password] <from-vault>" \
  "fill .uedc-ppkg-login_captcha-input <CODE>" \
  "click .uedc-ppkg-login_product-submit"
```

Click `.uedc-ppkg-login_product-submit` specifically — the generic `Log In` ref may not take.
Never open the EULA link. Success: `https://10.80.1.107/ui/`, header `admin`.

### Athena EPP

Same pattern, tighter timing: read the image and submit immediately.

```bash
agent-browser --session "$SESSION" --ignore-https-errors open 'https://10.80.1.106/ui/login.php'
agent-browser --session "$SESSION" screenshot 'img[src*="randcode.php"]' /tmp/itac-epp-captcha.png
# read /tmp/itac-epp-captcha.png -> CODE
agent-browser --session "$SESSION" batch --bail \
  "find label Username fill admin" \
  "fill input[type=password] <from-vault>" \
  "fill input[name=randcode] <CODE>" \
  "find role button click --name 'Log In'"
```

The consent checkbox is hidden and already checked — do not touch it. On `The code has expired`,
re-screenshot, re-read, and resubmit at once. Success: `https://10.80.1.106/ui/`, user `admin`.

## Teardown

```bash
agent-browser --session "$SESSION" close --all
agent-browser session list          # expect: No active sessions
rm -f /tmp/itac-*-captcha.png
```

## Reporting

Table of host, product, account, landing URL/screen only. No passwords, no CAPTCHA text.
State explicitly that only login happened and no settings were changed.

## Porting notes (Aside → agent-browser)

| Aside | agent-browser 0.34.0 | Status |
|---|---|---|
| `page.evaluate` | `eval <js>` | direct |
| locator fill / click | `fill`, `click`, `find label\|role ... fill\|click` | direct |
| `#username` / `#secretkey` / `#login_button` | same CSS selectors | direct |
| wait for message to clear | `wait --fn` / `wait <sel> --state hidden` | direct |
| element clip capture | `screenshot <selector> <path>` | direct (confirmed in `screenshot --help`) |
| `listBrowserTabs()` / `attachBrowserTab(targetId)` | `tab list --json` → `tab <targetId>` | direct |
| `chrome.tabGroups.query` (ITAC group) | — | **no equivalent**; match URLs from the target table |
| Notion table → REPL variable | `auth save --password-stdin` → `auth login` | replaced, and safer: the model never sees the secret |
| Aside Password Manager | agent-browser encrypted vault (`AGENT_BROWSER_ENCRYPTION_KEY`) | replaced |
