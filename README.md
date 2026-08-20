# z/OS Gateway

Browser-based dataset, USS, and job management for z/OS, built entirely on IBM z/OSMF REST APIs.

Reference environment: `yourhost.example.com` (z/OS V3R2, z/OSMF v30)

## Contents

- [1. Overview](#1-overview)
- [2. Architecture at a Glance](#2-architecture-at-a-glance)
- [3. Prerequisites](#3-prerequisites)
- [Part A - Getting IBM HTTP Server Running](#part-a---getting-ibm-http-server-running)
- [Part B - Configuring the Reverse Proxy to z/OSMF](#part-b---configuring-the-reverse-proxy-to-zosmf)
- [Part C - Adding HTTPS (Port 8443)](#part-c---adding-https-port-8443)
- [Part D - Deploying the Console Application Files](#part-d---deploying-the-console-application-files)
- [Part E - First-Time Login & Verification](#part-e---first-time-login--verification)
- [Troubleshooting](#troubleshooting)
- [Appendix A - Full Command Reference](#appendix-a---full-command-reference)
- [Appendix B - Alternative: Deploying with Zowe CLI](#appendix-b---alternative-deploying-with-zowe-cli)
- [Appendix C - Known Limitations & Open Items](#appendix-c---known-limitations--open-items)

## 1. Overview

z/OS Gateway is a browser-based console for working with z/OS datasets, USS files, and batch jobs - a self-hosted, Zowe-Explorer-style tree/tabs/editor interface that runs entirely against IBM z/OSMF's REST APIs. There is no custom backend application, no database, and no separate session store: IBM HTTP Server (IHS) reverse-proxies the console's API calls straight through to z/OSMF, and z/OSMF itself is the session store (a login exchanges a userid/password for a session cookie that every subsequent call reuses).

The console currently supports:

- **Datasets** - browse, create (PDS, PS, VSAM cluster, zFS), edit, copy, rename, delete, compare, submit as JCL, run REXX, download, and a Favorites list.
- **USS** - full file/folder browse, create, edit, copy, rename (via copy+delete), delete, permissions, and download.
- **Jobs** - a Zowe-Explorer-style job tree with structured Search Jobs (owner/prefix/status), search history, Start Polling Active Jobs, Sort Jobs, spool file browsing/download, cancel/purge, and MVS operator / TSO command shortcuts.
- A live SYSLOG tab and an Issue TSO Command action, both reachable from the header regardless of which section is open.

This guide covers everything needed to stand the Gateway up on a z/OS system that does not have it running yet: getting IBM HTTP Server itself running, configuring it as a reverse proxy in front of z/OSMF, adding HTTPS, deploying the console's static files, and verifying the result - plus a troubleshooting section built from the real issues hit while setting this up the first time.

### 1.1 A note on the example values in this guide

Wherever this guide needs a concrete hostname, started task name, keyring name, or port, it uses the values from the live reference deployment (host `yourhost.example.com`, started task `WWWSVR1`, keyring `WWWSVR1PROXY`, HTTP/HTTPS ports 8081/8443, z/OSMF on 10443). If you are installing on a different z/OS system, substitute your own hostname, started task name, and any site-specific naming conventions - the structure of every command and config block stays the same.

## 2. Architecture at a Glance

Three moving pieces, all on the same z/OS system:

- **z/OSMF** - already running, exposes the Files, Jobs, TSO, Consoles, and AMS REST APIs the console calls. In the reference environment this listens on port 10443.
- **IBM HTTP Server (IHS)** - an Apache-derived web server, started task `WWWSVR1` in the reference environment, `ServerRoot /etc/wwwsvr1`, `DocumentRoot /etc/wwwsvr1/htdocs`. It serves the console's static files directly and reverse-proxies everything under `/zosmf` through to z/OSMF on port 10443.
- **The console itself** - static HTML/CSS/JS (no build step, no server-side code) deployed into IHS's DocumentRoot under `/console/`. The browser talks only to IHS; IHS talks to z/OSMF server-to-server.

Why a reverse proxy at all, rather than the browser calling z/OSMF directly: z/OSMF rejects any REST call whose Origin/Referer headers don't match its own address, and browsers do not allow JavaScript to override those headers. Serving the console from the same origin as the proxy (IHS) and letting IHS set Origin/Referer on the outbound leg to z/OSMF sidesteps the whole problem with zero custom backend code - it is pure Apache configuration (Part B below).

Login flow: the console's login page POSTs Basic-auth credentials to `/zosmf/services/authenticate` through the IHS proxy; z/OSMF validates them against RACF/SAF and returns a session cookie (`LtpaToken2`). Every subsequent `/zosmf/*` call from the browser carries that cookie automatically and is authenticated as that user - not a shared service account. Signing out calls `DELETE` on the same endpoint to invalidate the cookie.

## 3. Prerequisites

- A z/OS system with z/OSMF configured and active, listening on a TLS port (10443 in the reference environment). This guide does not cover standing up z/OSMF itself.
- IBM HTTP Server for z/OS installed, with a started task already defined (`WWWSVR1` in the reference environment). This guide covers getting that started task running and configured - not installing IHS from scratch.
- RACF (or equivalent SAF) authority to: manage digital certificates and keyrings (RACDCERT), define RDATALIB profiles, and start/stop the IHS started task. Some of this - particularly plain MVS console `START` commands - needs real console command authority, which RACF SPECIAL alone does not grant (see [Troubleshooting](#troubleshooting)).
- `curl` on the administrator's workstation, used to deploy the console's static files via z/OSMF's REST API directly - no installation needed on most systems (curl ships with Windows 10/11, macOS, and virtually every Linux distribution out of the box, which matters if you're working from a locked-down corporate laptop with no ability to install new software). [Part D](#part-d---deploying-the-console-application-files) covers this as the primary deployment method, with an optional Zowe CLI-based alternative in [Appendix B](#appendix-b---alternative-deploying-with-zowe-cli) for anyone who already has Node.js/npm available and prefers it.
- A modern desktop browser to use the console once it's deployed.

> **This guide assumes a Windows administrator workstation** (PowerShell, backslash file paths like `console\index.html`). Every command below is written for that environment; on macOS/Linux, drop the `.exe` from `curl.exe` (see the note below) and swap backslash paths for forward slashes.
>
> **A note on `curl.exe`:** every curl command in this guide is written as `curl.exe`, not `curl`. PowerShell ships a built-in alias named `curl` that actually runs `Invoke-WebRequest` - a completely different tool that doesn't understand flags like `-k`, `-u`, or `-X` the same way, and fails with an "ambiguous parameter" error if you try. Typing `curl.exe` bypasses that alias and calls the real curl binary Windows 10/11 ships. If you're on macOS or Linux, there's no such alias - use plain `curl` there instead.

## Part A - Getting IBM HTTP Server Running

If IHS is already running on your system, skip to Part B. If you're not sure, section A.1 below shows how to check.

### A.1 Check whether it's already running

From TSO, check for a listener on the port(s) IHS is configured to use:

```
D TCPIP,,N,SOCKETS
```

(note the double comma - this is the correct syntax for this Display TCP/IP command; a single comma will not work.) Look for a `LISTEN` entry on your configured port(s), e.g. 8081/8443.

From OMVS/USS, check for the actual process:

```
ps -ef | grep httpd
```

### A.2 Start the started task

This requires real MVS console command authority - not just RACF SPECIAL (see [Troubleshooting](#troubleshooting) if you hit an authority error here):

```
S WWWSVR1
```

### A.3 Validate httpd.conf before every restart

Always syntax-check the configuration file before recycling the server - a broken or empty `httpd.conf` will bring the whole site down with no obvious error beyond "no listening sockets available, shutting down" in the error log:

```
/etc/wwwsvr1/bin/apachectl configtest
```

Expect the output `Syntax OK`. If it isn't, fix the reported line before continuing.

### A.4 The detached-master gotcha (important)

> **Gotcha:** `WWWSVR1`'s STOP and START actions are short-lived BPXBATCH launcher jobs (`apachectl -k stop/start -f conf/httpd.conf -DNO_DETACH`) - the started-task job itself exits in under a second either way, by design, while the real httpd master process detaches and keeps running independently in USS. A STOP followed by START does not reliably kill or replace that detached master. If you edit httpd.conf, change a keyring, or update a certificate and then just cycle the STC, your changes may silently not take effect because the old master is still the one answering requests.

The reliable procedure after any configuration or certificate change:

1. Confirm the master is actually running and note its PID(s): `ps -ef | grep httpd`
2. Force-kill every httpd-related PID found (submit this as a batch job if you can't run OMVS commands interactively): `kill -9 <pid>`
3. Confirm nothing httpd-related remains: `ps -ef | grep httpd` (should return nothing)
4. Only then have an authorized operator issue a real start: `S WWWSVR1`
5. Check `/etc/wwwsvr1/logs/error_log` for a clean startup with no `SSL0139W` or `SSL0266E` lines.

### A.5 Confirm it's serving

```
curl.exe -i http://yourhost.example.com:8081/
```

Expect a 200 response with the IHS/console landing page. If you get a connection refused or timeout, re-check A.1-A.4.

## Part B - Configuring the Reverse Proxy to z/OSMF

This section wires IHS to reverse-proxy everything under `/zosmf` through to z/OSMF, over plain HTTP first (port 8081) - Part C adds HTTPS on top of a working proxy.

### B.1 Enable the required modules

In httpd.conf, make sure these LoadModule lines are present and not commented out:

```
LoadModule proxy_module modules/mod_proxy.so
LoadModule proxy_http_module modules/mod_proxy_http.so
LoadModule ibm_ssl_module modules/mod_ibm_ssl.so
```

### B.2 Create a keyring and trust z/OSMF's certificate authority

Run as a security administrator (or a userid with equivalent RACF authority). This creates a keyring owned by the IHS started task and connects the CA certificate that signed z/OSMF's server certificate into it:

```
RACDCERT ID(WWWSVR1) ADDRING(WWWSVR1PROXY)
RACDCERT ID(WWWSVR1) CONNECT(CERTAUTH LABEL('VSICA') RING(WWWSVR1PROXY) USAGE(CERTAUTH))
```

If you don't already know the label of the CA certificate that signed z/OSMF's certificate, find it with:

```
openssl s_client -connect yourhost.example.com:10443 -showcerts
```

and match the issuer shown against the CERTAUTH certificates already defined in RACF.

### B.3 Grant keyring access (RDATALIB)

On systems where the RDATALIB class is active and RACLISTed, owning the keyring is not enough by itself - an explicit covering profile is also required, or IHS fails to start with `SSL0139W` (see [Troubleshooting](#troubleshooting)):

```
RDEFINE RDATALIB WWWSVR1.WWWSVR1PROXY.LST UACC(NONE)
PERMIT WWWSVR1.WWWSVR1PROXY.LST CLASS(RDATALIB) ID(WWWSVR1) ACCESS(READ)
SETROPTS RACLIST(RDATALIB) REFRESH
```

### B.4 Add the proxy configuration to httpd.conf

```
KeyFile /saf WWWSVR1/WWWSVR1PROXY
SSLProxyEngine On
SSLProxyCheckPeerCN Off

<Location /zosmf>
    ProxyPass https://yourhost.example.com:10443/zosmf
    ProxyPassReverse https://yourhost.example.com:10443/zosmf
    RequestHeader set Origin "https://yourhost.example.com:10443"
    RequestHeader set Referer "https://yourhost.example.com:10443/zosmf/"
    RequestHeader set X-CSRF-ZOSMF-HEADER "true"
</Location>
```

Notes on this block:

- `SSLProxyCheckPeerCN Off` is needed if z/OSMF's certificate CN does not match the hostname you're connecting to (common when a certificate is shared across system images). Trust still comes from the CA chain added in B.2 - this setting only disables the additional hostname-match check.
- The Origin/Referer/`X-CSRF-ZOSMF-HEADER` lines are what let the browser avoid z/OSMF's `IZUG846W` "remote site is not permitted" rejection and its CSRF check on PUT/POST/DELETE calls - IHS sets them on every proxied request regardless of what the browser itself sent.

### B.5 Recycle IHS and test

Follow the safe-restart procedure in A.3-A.4, then:

```
curl.exe -i http://yourhost.example.com:8081/zosmf/info
```

Expect a 200 response containing real z/OSMF JSON. If instead you get a proxy or SSL error, check [Troubleshooting](#troubleshooting) before moving on to Part C.

## Part C - Adding HTTPS (Port 8443)

The plain-HTTP proxy from Part B is enough to prove the connection works, but the console's login will not actually stay signed in over it: z/OSMF sets its session cookie with the Secure flag, and browsers silently refuse to send Secure cookies back over plain HTTP. Serving the console over HTTPS fixes this.

### C.1 Generate a server certificate

> **Important:** This certificate must be connected into the SAME keyring already used for the proxy leg (`WWWSVR1PROXY`), and must NOT be marked DEFAULT. See the gotcha in C.2 for why - getting this wrong produces confusing, hard-to-diagnose SSL failures.

```
RACDCERT ID(WWWSVR1) GENCERT SUBJECTSDN(CN('yourhost.example.com') O('YourOrg') C('AU')) -
  WITHLABEL('WWWSVR1SRVR') SIZE(2048) NOTAFTER(DATE(2030-12-31))
RACDCERT ID(WWWSVR1) CONNECT(ID(WWWSVR1) LABEL('WWWSVR1SRVR') -
  RING(WWWSVR1PROXY) USAGE(PERSONAL))
SETROPTS RACLIST(DIGTCERT) REFRESH
SETROPTS RACLIST(RDATALIB) REFRESH
```

This is a self-signed certificate - browsers will show a trust warning until it is replaced with one issued by a CA the browser already trusts, or accepted once per browser (see C.5).

### C.2 Why the ring and DEFAULT flag matter

A keyring's DEFAULT personal certificate is opportunistically offered as a TLS client certificate on any outbound connection made through that ring - including the outbound proxy leg to z/OSMF configured in Part B. If the new server certificate is added to a separate ring, or added to this ring as DEFAULT, one of two failures results:

- A separate ring with no CA trust configured on it yet: outbound proxy calls fail with `SSL0266E ... GSKit error 8: Certificate validation error`.
- The certificate marked DEFAULT (in either ring): z/OSMF aborts the TLS handshake outright on receiving an unexpected client certificate it never asked for - `SSL0266E ... GSKit error 420: Socket closed by remote partner`.

The fix used throughout this guide: one ring (`WWWSVR1PROXY`) for everything, the server certificate connected without DEFAULT, and selected explicitly for inbound connections via `SSLServerCert` (C.3). A non-default personal certificate sitting in the ring is available to be selected by label but is never auto-offered as a client certificate.

### C.3 Add the HTTPS virtual host to httpd.conf

Append this after the proxy configuration from Part B:

```
Listen 8443
<VirtualHost *:8443>
    ServerName YOURHOST.example.com
    SSLEnable
    SSLServerCert WWWSVR1SRVR
</VirtualHost>
```

No `KeyFile` line is needed inside the `<VirtualHost>` block - it inherits the global `KeyFile /saf WWWSVR1/WWWSVR1PROXY` set in Part B. `SSLServerCert` picks the personal certificate by label for the inbound (browser-facing) identity, independently of the ring's DEFAULT.

### C.4 Recycle IHS and test

Follow the safe-restart procedure in A.3-A.4, then:

```
curl.exe -ik https://yourhost.example.com:8443/zosmf/info
```

Expect a 401 with no credentials supplied (this actually proves the proxy leg survived the TLS-terminating virtual host correctly) and a real 200 JSON response when valid z/OSMF credentials are supplied.

### C.5 Certificate trust warning

Because the certificate from C.1 is self-signed, browsers will show a security warning the first time each user visits `https://yourhost.example.com:8443/`. Users can accept/trust it once per browser, or the certificate can be replaced later with one issued by a CA already trusted by your organization's browsers.

## Part D - Deploying the Console Application Files

The console is entirely static files - no build step, no server-side code. Deploying it means copying `zos/site/` (renamed from this repo's root `site/` in the extracted layout - see note below) and `console/` into IHS's DocumentRoot on z/OS.

> **Note on paths:** this repository was split out of a larger monorepo, so the files referenced below live at `site/` and `console/` at the root of *this* repository (previously `zos/site/` and `zos/console/` in the combined repo). Adjust the local paths in the commands below to match wherever you've checked this repository out.

### D.1 What gets deployed, and where

| Local file | USS destination | Notes |
|---|---|---|
| `site/index.html` | `/etc/wwwsvr1/htdocs/index.html` | Landing page |
| `console/index.html` | `/etc/wwwsvr1/htdocs/console/index.html` | Console shell |
| `console/login.html` | `/etc/wwwsvr1/htdocs/console/login.html` | Sign-in page |
| `console/console.js` | `/etc/wwwsvr1/htdocs/console/console.js` | Application logic |
| `console/console.css` | `/etc/wwwsvr1/htdocs/console/console.css` | Styles |

> **Why curl:** This guide deploys using curl rather than a CLI tool that needs installing. curl ships built in with Windows 10/11, macOS, and virtually every Linux distribution, so there is nothing to install, download, or get approved on a locked-down corporate laptop. It talks to z/OSMF's Files REST API directly - the exact same API a purpose-built tool like Zowe CLI would call, just without the extra layer. If you do already have Node.js/npm available and would prefer Zowe CLI's friendlier command syntax, an equivalent set of commands is in [Appendix B](#appendix-b---alternative-deploying-with-zowe-cli) - but nothing in this guide requires installing anything beyond what your workstation already has.

Every command below authenticates directly against z/OSMF on its own port (10443 in the reference environment) - not through the IHS reverse proxy - using your own z/OS userid and password. Replace `USERID` and the local file paths with your own before running them. `-k` skips certificate validation, needed only because the reference z/OSMF instance's certificate is not signed by a CA your workstation trusts; drop it if yours is.

> **On typing your password:** these commands use `-u "USERID"` (no `:PASSWORD` after it) on purpose - curl then prompts for the password interactively instead of it appearing in the command itself. Typing `-u "USERID:PASSWORD"` puts the password in your shell's command history in plaintext, and if you ever paste a command like that into a chat, ticket, or screen share, that password should be treated as compromised and rotated. If you're running many of these in a row and don't want to retype the password every time, an `_netrc` file (PowerShell: `$env:USERPROFILE\_netrc`) is a safer alternative than typing it inline - see curl's own documentation for the format.

### D.2 Create the destination directories

On a fresh install `/etc/wwwsvr1/htdocs/console` does not exist yet, and an upload into a directory that doesn't exist fails - create the path once, first:

```
curl.exe -k -u "USERID" -X POST "https://yourhost.example.com:10443/zosmf/restfiles/fs/etc/wwwsvr1/htdocs" -H "X-CSRF-ZOSMF-HEADER: true" -H "Origin: https://yourhost.example.com:10443" -H "Referer: https://yourhost.example.com:10443/zosmf/" -H "Content-Type: application/json" -d "{\"type\":\"directory\",\"mode\":\"rwxr-xr-x\"}"

curl.exe -k -u "USERID" -X POST "https://yourhost.example.com:10443/zosmf/restfiles/fs/etc/wwwsvr1/htdocs/console" -H "X-CSRF-ZOSMF-HEADER: true" -H "Origin: https://yourhost.example.com:10443" -H "Referer: https://yourhost.example.com:10443/zosmf/" -H "Content-Type: application/json" -d "{\"type\":\"directory\",\"mode\":\"rwxr-xr-x\"}"
```

`mode rwxr-xr-x` (755) makes each directory world-readable/executable so IHS - which runs under its own started-task userid, not yours - can traverse into it and serve files back out; without it, files can upload successfully yet still 403 in the browser. If `/etc/wwwsvr1/htdocs` already exists (it will, on any system where IHS is already serving a DocumentRoot from it), the first command returns an "already exists" error - that's fine, skip it and just create the console subdirectory.

### D.3 Upload each file

Text files need `X-IBM-Data-Type: text;fileEncoding=IBM-1047` so z/OSMF converts them to EBCDIC correctly; binary files (images) need `X-IBM-Data-Type: binary` instead, or the upload will corrupt them.

**Text file example:**

```
curl.exe -k -u "USERID" -X PUT "https://yourhost.example.com:10443/zosmf/restfiles/fs/etc/wwwsvr1/htdocs/console/index.html" -H "X-CSRF-ZOSMF-HEADER: true" -H "Origin: https://yourhost.example.com:10443" -H "Referer: https://yourhost.example.com:10443/zosmf/" -H "X-IBM-Data-Type: text;fileEncoding=IBM-1047" --data-binary "@console\index.html"
```

**Binary file example** (for images or other non-text assets you add):

```
curl.exe -k -u "USERID" -X PUT "https://yourhost.example.com:10443/zosmf/restfiles/fs/etc/wwwsvr1/htdocs/console/your-image.png" -H "X-CSRF-ZOSMF-HEADER: true" -H "Origin: https://yourhost.example.com:10443" -H "Referer: https://yourhost.example.com:10443/zosmf/" -H "X-IBM-Data-Type: binary" --data-binary "@console\your-image.png"
```

The rest of the files, changing only the destination path, the local file, and the data-type header as shown:

| Local file | USS destination | X-IBM-Data-Type |
|---|---|---|
| `site/index.html` | `/etc/wwwsvr1/htdocs/index.html` | `text;fileEncoding=IBM-1047` |
| `console/index.html` | `/etc/wwwsvr1/htdocs/console/index.html` | `text;fileEncoding=IBM-1047` |
| `console/login.html` | `/etc/wwwsvr1/htdocs/console/login.html` | `text;fileEncoding=IBM-1047` |
| `console/console.js` | `/etc/wwwsvr1/htdocs/console/console.js` | `text;fileEncoding=IBM-1047` |
| `console/console.css` | `/etc/wwwsvr1/htdocs/console/console.css` | `text;fileEncoding=IBM-1047` |

### D.4 Verify the upload

```
curl.exe -k -u "USERID" "https://yourhost.example.com:10443/zosmf/restfiles/fs?path=/etc/wwwsvr1/htdocs/console" -H "Origin: https://yourhost.example.com:10443" -H "Referer: https://yourhost.example.com:10443/zosmf/"
```

Confirm all six console files are listed with non-zero sizes (GET calls don't need the `X-CSRF-ZOSMF-HEADER` - that's only required on PUT/POST/DELETE). A full end-to-end check is easiest via the browser once IHS is up (Part E).

## Part E - First-Time Login & Verification

1. Open `https://yourhost.example.com:8443/console/` in a browser. Accept/trust the self-signed certificate warning if this is the first visit (see C.5).
2. Sign in with a valid z/OS userid and password - this is checked directly against RACF/SAF via z/OSMF; there is no separate account to create for the Gateway itself.
3. **Data Sets check:** enter your own high-level qualifier (e.g. `YOURID.*`) in the Data Sets filter and click List - you should see your own datasets.
4. **USS check:** browse to a known path, e.g. `/u/youruserid`.
5. **Jobs check:** click Refresh in the Jobs section - you should see recent job history for your userid.
6. **Sign out** (top right) and confirm you're returned to the login page, then that the session is actually gone (reloading the console redirects back to login rather than showing cached data).

## Troubleshooting

Every row below is a real issue hit (and resolved) while standing up the reference deployment.

| Symptom | Likely Cause | Fix |
|---|---|---|
| "no listening sockets available, shutting down" in error_log | httpd.conf is empty, missing, or has a syntax error | Run `apachectl configtest` (A.3); restore/rebuild the file, then restart via the safe procedure in A.4 |
| Config or keyring changes don't seem to take effect after a restart | The detached httpd master was never actually killed | Follow the force-kill procedure in A.4 before every restart, not just STOP/START |
| `SSL0139W Initialization error, Permission denied` | RDATALIB profile for the keyring is missing or not permitted | Section B.3 |
| `SSLProxyCheckPeerCN: requested hostname didn't match common name in certificate` | z/OSMF's certificate CN doesn't match the hostname being connected to | `SSLProxyCheckPeerCN Off` (B.4) - trust already comes from the CA chain, not hostname matching |
| `SSL0266E GSKit error 8: Certificate validation error` (on the HTTPS vhost's own outbound calls) | That vhost's ring doesn't trust the z/OSMF CA certificate yet | Connect the CA cert (B.2) into whichever ring the vhost actually uses - see C.2 |
| `SSL0266E GSKit error 420: Socket closed by remote partner` | A DEFAULT personal certificate on the proxy ring is being offered as a TLS client certificate; z/OSMF rejects it | Remove DEFAULT, select the certificate explicitly via `SSLServerCert` instead (C.2-C.3) |
| Login succeeds (200, cookie set) but every call after that returns 401 | `LtpaToken2` has the Secure flag; the console is being served over plain HTTP | Use the HTTPS vhost (Part C), not port 8081, for anything involving login |
| `"IZUG846W ... remote site '' is not permitted"` | A client is calling z/OSMF directly without Origin/Referer headers | Only relevant when bypassing the reverse proxy (e.g. curl/testing) - real browser traffic through IHS already has these set (B.4) |
| Right-click menu on a PDS row has no Open option | Expected behaviour - a PDS's own row is never directly openable, only its members are | Expand the PDS first, then right-click a member |
| `"LMINIT error - ISRZ002 Data set in use"` expanding a PDS (often `<userid>.ISPF.PROFILE`) | That dataset is exclusively locked by another live ISPF/TSO session for the same user | Not a Gateway bug - log off the other session, or ignore it for a profile dataset (nothing useful to browse there anyway) |
| `S WWWSVR1` fails / `"USER ... DOES NOT HAVE CONSOLE COMMAND AUTHORITY"` | Plain MVS console commands need real console command authority - RACF SPECIAL alone does not grant it | Have an operator or a userid with console authority issue the S/P command |

## Appendix A - Full Command Reference

Every command from this guide, grouped by part, in copy-pasteable order.

### Part A - Getting IHS Running

```
D TCPIP,,N,SOCKETS
ps -ef | grep httpd
S WWWSVR1
/etc/wwwsvr1/bin/apachectl configtest
kill -9 <pid>
curl.exe -i http://yourhost.example.com:8081/
```

### Part B - Reverse Proxy

```
RACDCERT ID(WWWSVR1) ADDRING(WWWSVR1PROXY)
RACDCERT ID(WWWSVR1) CONNECT(CERTAUTH LABEL('VSICA') RING(WWWSVR1PROXY) USAGE(CERTAUTH))
openssl s_client -connect yourhost.example.com:10443 -showcerts
RDEFINE RDATALIB WWWSVR1.WWWSVR1PROXY.LST UACC(NONE)
PERMIT WWWSVR1.WWWSVR1PROXY.LST CLASS(RDATALIB) ID(WWWSVR1) ACCESS(READ)
SETROPTS RACLIST(RDATALIB) REFRESH
curl.exe -i http://yourhost.example.com:8081/zosmf/info
```

### Part C - HTTPS

```
RACDCERT ID(WWWSVR1) GENCERT SUBJECTSDN(CN('yourhost.example.com') O('YourOrg') C('AU')) -
  WITHLABEL('WWWSVR1SRVR') SIZE(2048) NOTAFTER(DATE(2030-12-31))
RACDCERT ID(WWWSVR1) CONNECT(ID(WWWSVR1) LABEL('WWWSVR1SRVR') -
  RING(WWWSVR1PROXY) USAGE(PERSONAL))
SETROPTS RACLIST(DIGTCERT) REFRESH
SETROPTS RACLIST(RDATALIB) REFRESH
curl.exe -ik https://yourhost.example.com:8443/zosmf/info
```

### Part D - Deploying the Console (curl)

```
curl.exe -k -u "USERID" -X POST "https://yourhost.example.com:10443/zosmf/restfiles/fs/etc/wwwsvr1/htdocs" -H "X-CSRF-ZOSMF-HEADER: true" -H "Origin: https://yourhost.example.com:10443" -H "Referer: https://yourhost.example.com:10443/zosmf/" -H "Content-Type: application/json" -d "{\"type\":\"directory\",\"mode\":\"rwxr-xr-x\"}"
curl.exe -k -u "USERID" -X POST "https://yourhost.example.com:10443/zosmf/restfiles/fs/etc/wwwsvr1/htdocs/console" -H "X-CSRF-ZOSMF-HEADER: true" -H "Origin: https://yourhost.example.com:10443" -H "Referer: https://yourhost.example.com:10443/zosmf/" -H "Content-Type: application/json" -d "{\"type\":\"directory\",\"mode\":\"rwxr-xr-x\"}"

curl.exe -k -u "USERID" -X PUT "https://yourhost.example.com:10443/zosmf/restfiles/fs/etc/wwwsvr1/htdocs/index.html" -H "X-CSRF-ZOSMF-HEADER: true" -H "Origin: https://yourhost.example.com:10443" -H "Referer: https://yourhost.example.com:10443/zosmf/" -H "X-IBM-Data-Type: text;fileEncoding=IBM-1047" --data-binary "@site\index.html"
curl.exe -k -u "USERID" -X PUT "https://yourhost.example.com:10443/zosmf/restfiles/fs/etc/wwwsvr1/htdocs/console/index.html" -H "X-CSRF-ZOSMF-HEADER: true" -H "Origin: https://yourhost.example.com:10443" -H "Referer: https://yourhost.example.com:10443/zosmf/" -H "X-IBM-Data-Type: text;fileEncoding=IBM-1047" --data-binary "@console\index.html"
curl.exe -k -u "USERID" -X PUT "https://yourhost.example.com:10443/zosmf/restfiles/fs/etc/wwwsvr1/htdocs/console/login.html" -H "X-CSRF-ZOSMF-HEADER: true" -H "Origin: https://yourhost.example.com:10443" -H "Referer: https://yourhost.example.com:10443/zosmf/" -H "X-IBM-Data-Type: text;fileEncoding=IBM-1047" --data-binary "@console\login.html"
curl.exe -k -u "USERID" -X PUT "https://yourhost.example.com:10443/zosmf/restfiles/fs/etc/wwwsvr1/htdocs/console/console.js" -H "X-CSRF-ZOSMF-HEADER: true" -H "Origin: https://yourhost.example.com:10443" -H "Referer: https://yourhost.example.com:10443/zosmf/" -H "X-IBM-Data-Type: text;fileEncoding=IBM-1047" --data-binary "@console\console.js"
curl.exe -k -u "USERID" -X PUT "https://yourhost.example.com:10443/zosmf/restfiles/fs/etc/wwwsvr1/htdocs/console/console.css" -H "X-CSRF-ZOSMF-HEADER: true" -H "Origin: https://yourhost.example.com:10443" -H "Referer: https://yourhost.example.com:10443/zosmf/" -H "X-IBM-Data-Type: text;fileEncoding=IBM-1047" --data-binary "@console\console.css"

curl.exe -k -u "USERID" "https://yourhost.example.com:10443/zosmf/restfiles/fs?path=/etc/wwwsvr1/htdocs/console" -H "Origin: https://yourhost.example.com:10443" -H "Referer: https://yourhost.example.com:10443/zosmf/"
```

## Appendix B - Alternative: Deploying with Zowe CLI

Part D deploys with curl so nothing needs installing. If you already have Node.js/npm available and are permitted to install global packages, Zowe CLI is a more convenient alternative that wraps the same z/OSMF REST calls in friendlier commands. Use this instead of Part D, not in addition to it.

### B.1 Install and configure Zowe CLI

On an administrator's workstation (not on z/OS itself):

```
npm install -g @zowe/cli
```

Create a zosmf profile pointed at z/OSMF's own direct port (10443 in the reference environment) - not the IHS proxy ports:

```
zowe config init
# or, non-interactively:
zowe profiles create zosmf-profile ZOS1 ^
  --host yourhost.example.com --port 10443 ^
  --user <your-userid> --password <your-password> ^
  --reject-unauthorized false
```

(`--reject-unauthorized false` is only needed while the z/OSMF certificate itself is self-signed/untrusted from the workstation's point of view.)

### B.2 Create the destination directories

```
zowe zos-files create uss-directory "/etc/wwwsvr1/htdocs" --mode rwxr-xr-x --zosmf-profile ZOS1
zowe zos-files create uss-directory "/etc/wwwsvr1/htdocs/console" --mode rwxr-xr-x --zosmf-profile ZOS1
```

### B.3 Upload each file

```
zowe zos-files upload file-to-uss "site\index.html" "/etc/wwwsvr1/htdocs/index.html" --encoding IBM-1047 --zosmf-profile ZOS1
zowe zos-files upload file-to-uss "console\index.html" "/etc/wwwsvr1/htdocs/console/index.html" --encoding IBM-1047 --zosmf-profile ZOS1
zowe zos-files upload file-to-uss "console\login.html" "/etc/wwwsvr1/htdocs/console/login.html" --encoding IBM-1047 --zosmf-profile ZOS1
zowe zos-files upload file-to-uss "console\console.js" "/etc/wwwsvr1/htdocs/console/console.js" --encoding IBM-1047 --zosmf-profile ZOS1
zowe zos-files upload file-to-uss "console\console.css" "/etc/wwwsvr1/htdocs/console/console.css" --encoding IBM-1047 --zosmf-profile ZOS1
```

Text files need `--encoding IBM-1047`; binary files (images) need `--binary` instead.

### B.4 Verify the upload

```
zowe zos-files list uss-file "/etc/wwwsvr1/htdocs/console" --zosmf-profile ZOS1
```

## Appendix C - Known Limitations & Open Items

- The `:8443` certificate is self-signed - browsers will show a trust warning until it's replaced with one issued by a trusted CA, or accepted once per browser.
- A few z/OSMF endpoints the console uses (the TSO/E `v1/tso` single-command API, the Consoles REST API for MVS operator commands, and the SYSLOG hardcopy-log API) are implemented against IBM's published documentation but had not been exercised end-to-end on every environment at the time of writing. Test Issue TSO Command and operator-command actions with something harmless first (e.g. `TIME`) in a new environment.
- z/OSMF's Files REST API "list members of a data set" call uses ISPF Library Management services under the caller's own userid, which needs that user's ISPF profile dataset. Expanding a PDS whose members can't currently be listed (most commonly the user's own `<userid>.ISPF.PROFILE` while an ISPF/TSO session is active elsewhere) will show an LMINIT/ISRZ002 error - this is expected z/OSMF/ISPF behaviour, not a defect in the console.
