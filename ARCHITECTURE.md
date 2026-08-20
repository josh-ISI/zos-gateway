# z/OS Gateway — architecture notes

## What's actually enabled on yourhost.example.com

Confirmed live via `/zosmf/info` and direct probes (z/OS V3R2, z/OSMF v30):

- **Jobs REST API** (`/zosmf/restjobs/jobs`) — confirmed working, returned
  real job history for YOURID (TSU and JOB entries, statuses, retcodes).
- **Files REST API — datasets** (`/zosmf/restfiles/ds`) — confirmed working,
  listed real `SYS1.*` datasets.
- **Files REST API — USS** (`/zosmf/restfiles/fs`) — confirmed working,
  listed the real USS root filesystem.
- **TSO REST API** (`/zosmf/tsoApp/tso`) — endpoint exists (405 on GET is
  expected; it requires POST to start an address space session). Not yet
  exercised — only needed if something can't be done via SAF-authenticated
  REST directly (e.g. RACF admin commands).
- Plugins active per `/zosmf/info`: Operator Consoles, Software Deployment,
  Variables, Workflow, IBM SDSF, Network Configuration Assistant, ISPF,
  Import Manager, Resource Monitoring, Workload Management, Security
  Configuration Assistant, Cloud Provisioning. (Jobs/Files/TSO are core
  z/OSMF services and don't appear in this plugin list, which is why they
  were verified by direct call instead.)

### Important quirk: the Origin/Referer requirement

Every REST call to this z/OSMF instance is rejected with
`IZUG846W ... remote site "" is not permitted` unless the request includes
both:
```
Origin: https://yourhost.example.com:10443
Referer: https://yourhost.example.com:10443/zosmf/
```
A real browser sends these automatically; `curl`/most HTTP clients don't
unless told to. Any tool we write against this system needs to set both
headers on every request. This is **not** a real security boundary (it's
trivially spoofable, confirmed from a network with no relationship to the
VPN the maintainer normally uses) — it should not be relied on as the access control
for whatever we put in front of this.

### CSRF header for mutating calls (confirmed)

PUT/POST/DELETE calls to z/OSMF REST APIs need `X-CSRF-ZOSMF-HEADER: <any value>`
in addition to the Origin/Referer pair above — same idea, CSRF protection for
browser-originated sessions. Confirmed live: allocate (POST), write (PUT),
copy (PUT), delete (DELETE), and job submit (PUT)/purge (DELETE) all require
it; omitting it gets rejected the same way missing Origin/Referer does.

### Session model (confirmed)

`POST /zosmf/services/authenticate` with Basic auth returns
`{"returnCode":0,...}` plus a `Set-Cookie: LtpaToken2=...` header. That
cookie alone (no more Basic auth) is enough to authenticate every
subsequent call — confirmed by re-fetching `/zosmf/info` with only the
cookie. `DELETE /zosmf/services/authenticate` invalidates it. `zos/lib`
implements exactly this: `login()` trades user/pass for the cookie once,
every other call reuses it, `logout()` invalidates it.

## Decisions (2026-07-31)

- **yourid has RACF SPECIAL** (full authority, not scoped to an HLQ). SAF/RACF
  will not stop a SPECIAL user's own console from deleting `SYS1.PROCLIB` —
  there is no authority boundary to catch an application bug here. So the
  client/server-side protected-HLQ guardrail (`EX_PROTECTED_HLQ` in
  `console.js`) matters, if anything more strictly, since RACF gives zero
  safety net for this identity.
- **Console frontend will be hosted on z/OS**, once the webserver there is
  configured (not done yet — open item).
- **Auth: a login form backed by z/OSMF's own authenticate call is
  sufficient** — no need to reinvent FTP-login-style credential checking.
  But this surfaces a real technical constraint, not just a design
  preference:

### The Origin/CORS wrinkle this creates

z/OSMF's site-restriction check (see above) requires the `Origin` header on
every REST call to literally be `https://yourhost.example.com:10443` — its own
address. If the console's static assets are served from a *different* port
on the same host (e.g. the new webserver on :80/:8080/whatever) and the
browser's JavaScript calls z/OSMF directly via `fetch()`, the browser will
automatically set `Origin` to the **console's own origin** (the webserver's
port), not z/OSMF's — and browsers do not allow JS to override `Origin`.
That request would get the same `IZUG846W` rejection we hit initially,
except this time we can't fix it with a header override because the browser
controls that header, not our code.

Practical options:
1. **Serve the console from the same origin as z/OSMF** (i.e. `:10443`
   itself, if the webserver can be configured as a context/app inside the
   same Liberty instance z/OSMF runs on, or if z/OSMF can host static
   content). Cleanest, but depends on what's actually possible on this
   system.
2. **A minimal server-side relay** on the new webserver: browser talks to
   the console's own origin only; that server-side code holds the
   Origin/Referer/CSRF headers and the LtpaToken2 cookie, and proxies
   requests through to z/OSMF on :10443 server-to-server (no browser CORS
   restriction applies server-to-server). This is effectively `zos/lib`
   running behind the login form instead of the browser calling z/OSMF
   directly — still just a login page from the user's perspective, but
   there's a small backend behind it. Depends on what server-side
   scripting the new webserver supports.

Which of these is viable depends on what the webserver actually is — see
open questions below.

## `zos/` layout (current)

- `zos/lib/client.js` — **built and live-tested.** Node, no dependencies
  (matches `auth-proxy/auth-service.js`'s style). Handles Origin/Referer/
  CSRF headers, LtpaToken2 login/reuse/logout, TLS, and JSON/error parsing
  behind a `.raw(method, path, opts)` call.
- `zos/lib/datasets.js` — **built and live-tested** against
  `YOURID.ZOSLIB.PDS`/`PDS2`: `list`, `listMembers`, `read`, `write`,
  `allocate` (explicit attrs or `{like: dsn}`), `deleteDataset`,
  `copyMember`, `copyWholePds`. No temp datasets, no IEBCOPY EXCLUDE, no
  hand-sized `SPACE=` guesses, no copy-out/verify/delete-original ordering
  to get wrong.
- `zos/lib/jobs.js` — **built and live-tested** end to end (submit → poll →
  read spool → purge) against job YOURIDT/JOB00078 and YOURIDL/JOB00079.
  `submit`, `status`, `waitForOutput`, `listSpoolFiles`, `readSpoolFile`,
  `runAndCapture` (submit+wait+read-all+purge in one call, the equivalent of
  the old `exRunJob`), `purge`. Replaces `submit-job.ps1`'s sockdev
  card-reader/printer capture entirely.
- `zos/uss.*` — not started; USS Files REST API is confirmed live if needed.
- `zos/console/` — not started; frontend, likely reusing the shape of the
  existing Explorer UI (tree/tabs/editor), calling relative `/zosmf/*` paths
  against the IHS reverse proxy (see below) instead of `zos/lib` directly —
  `zos/lib` stays useful for anything scripted/server-side, but the browser
  talks straight to the proxy now that the CORS problem has a fix.
- `zos/auth/` — simplified: no custom backend needed after all. A static
  login page's JS does `fetch('/zosmf/services/authenticate', {headers:
  {Authorization: 'Basic '+btoa(user+':'+pass)}})` through the IHS reverse
  proxy; the browser gets the `LtpaToken2` cookie directly from that
  response (cookies are host-scoped, so it's valid for both :8081 and
  :10443 on this host) and every subsequent `/zosmf/*` call from the console
  just carries it automatically. No server-side session store, no Phase 2
  gap — each request is the logged-in user's own identity by construction.

### Hosting the console on z/OS: the IHS reverse-proxy solution (confirmed configurable)

The webserver stood up on this system is **IBM HTTP Server** (Apache-
derived), listening on `:8081` (plain HTTP so far, no TLS configured on that
port). Read the live config at `/etc/wwwsvr1/conf/httpd.conf` via the USS
Files REST API:
- `ServerRoot "/etc/wwwsvr1"`, `Listen 8081`, `DocumentRoot
  "/etc/wwwsvr1/htdocs"`, `ServerName YOURHOST.example.com`.
- `mod_headers` already loaded. `mod_proxy`, `mod_proxy_http`, and
  `mod_ibm_ssl` are installed but commented out.

This resolves option 2 above (server-side relay) with **zero custom backend
code** — pure Apache config. Final, confirmed-working block:
```
LoadModule proxy_module modules/mod_proxy.so
LoadModule proxy_http_module modules/mod_proxy_http.so
LoadModule ibm_ssl_module modules/mod_ibm_ssl.so
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
IHS's `SSLProxyEngine On` needs a `KeyFile` containing the trust chain for
the origin server (z/OSMF). z/OSMF's serving cert
(`CN=IZUSVR_VS01zOSMFCert`) is self-signed by a CERTAUTH cert already in
RACF, labeled `VSICA` (confirmed via `openssl s_client` against :10443 —
issuer `CN=172.26.1.2_SELF_CACERT`, which matches `VSICA` on IZUSVR's own
`ZOSMF_RING`). WWWSVR1 (the IHS started task) had no keyrings of its own, so
rather than touch IZUSVR's ring, the maintainer created a new one and connected the
existing CERTAUTH cert into it (CERTAUTH certs are shared RACF objects, not
private to the userid that first added them):
```
RACDCERT ID(WWWSVR1) ADDRING(WWWSVR1PROXY)
RACDCERT ID(WWWSVR1) CONNECT(CERTAUTH LABEL('VSICA') RING(WWWSVR1PROXY) USAGE(CERTAUTH))
```

**Two more issues surfaced getting this actually working, both resolved:**

1. **RDATALIB permission.** Even though WWWSVR1 owns `WWWSVR1PROXY`, this
   system has RACF class `RDATALIB` both active and RACLISTed, which means
   keyring access needs an explicit covering profile — ring ownership alone
   wasn't enough. Symptom: `SSL0139W: Initialization error, Permission
   denied.` in `/etc/wwwsvr1/logs/error_log` at httpd startup. Fix:
   ```
   RDEFINE RDATALIB WWWSVR1.WWWSVR1PROXY.LST UACC(NONE)
   PERMIT WWWSVR1.WWWSVR1PROXY.LST CLASS(RDATALIB) ID(WWWSVR1) ACCESS(READ)
   SETROPTS RACLIST(RDATALIB) REFRESH
   ```
2. **Hostname mismatch on the proxied cert check.** IHS 9.0.5.26 includes
   `SSLProxyCheckPeerCN` (added via IBM APAR PM73304), which by default
   verifies the backend cert's CN matches the hostname being connected to.
   z/OSMF's cert CN is `IZUSVR_VS01zOSMFCert`, not `yourhost.example.com`, so
   the proxy connection failed with `SSLProxyCheckPeerCN: requested
   hostname 'yourhost.example.com' didn't match common name in certificate`
   even after the keyring/trust issue was fixed. Since the CA trust chain
   (`VSICA`) is already what we're relying on, not hostname matching,
   `SSLProxyCheckPeerCN Off` resolves it.

**Operational gotcha that cost the most time:** this WWWSVR1 STC's
`ACTION='STOP'`/plain-start commands are just short-lived BPXBATCH launcher
jobs (`apachectl -k stop/start -f conf/httpd.conf -DNO_DETACH`) — the STC
job itself exits in under a second either way, by design, while the actual
httpd master runs on as a detached USS process. Several rounds of
`ACTION='STOP'` + `S WWWSVR1` did **not** actually kill the running master
(confirmed via `ps -ef`: the same master pid persisted across multiple
"restarts," so httpd.conf edits and the RDATALIB fix weren't being
exercised by a truly fresh process). Diagnosed by checking `ps -ef|grep
httpd` via a submitted BPXBATCH job rather than trusting STC job-end status
as a proxy for "is httpd actually down." Fix: force-kill the actual PIDs
(`kill -9`) via a submitted job, confirm via `ps -ef` that nothing
httpd-related remains, *then* have an authorized operator issue a real `S WWWSVR1` (plain
start commands need real MVS console authority — `yourid` doesn't have it;
attempting via z/OSMF's Consoles REST API got `IKJ55353I USER YOURID DOES
NOT HAVE CONSOLE COMMAND AUTHORITY`). After that sequence, `error_log`
showed a genuinely clean startup (no SSL errors) and the proxy worked.

**Confirmed fully working (2026-08-02):** `GET http://yourhost.example.com:8081/zosmf/info`
(200, real z/OSMF JSON), `PUT .../zosmf/restjobs/jobs` (201, real job
submitted), `DELETE .../zosmf/restjobs/jobs/{name}/{id}` (200, purged) — all
via plain Basic auth on port 8081, zero manual Origin/Referer/CSRF headers
needed client-side. The IHS reverse proxy is done.

### Adding real HTTPS (port 8443): the Secure-cookie problem and its fix

Once the login page and console were built and deployed to `:8081`, the full
login flow broke silently: `POST /zosmf/services/authenticate` succeeded
(200, real cookie in the response), but every subsequent `/zosmf/*` call
came back 401. Cause: z/OSMF sets `LtpaToken2` with the `Secure` flag, and
browsers refuse to send `Secure` cookies back over plain HTTP. Serving the
console over `:8081` (HTTP) meant the cookie was set once and then silently
never resent. Two fixes were possible — strip the `Secure` flag (client-side
workaround) or give IHS real HTTPS. Real HTTPS was chosen.

**Cert and keyring setup:**
```
RACDCERT ID(WWWSVR1) GENCERT SUBJECTSDN(CN('yourhost.example.com') O('YourOrg') C('AU')) -
  WITHLABEL('WWWSVR1SRVR') SIZE(2048) NOTAFTER(DATE(2030-12-31))
RACDCERT ID(WWWSVR1) CONNECT(ID(WWWSVR1) LABEL('WWWSVR1SRVR') -
  RING(WWWSVR1PROXY) USAGE(PERSONAL))
SETROPTS RACLIST(DIGTCERT) REFRESH
SETROPTS RACLIST(RDATALIB) REFRESH
```
This is a **self-signed** cert (browsers will show a warning until/unless
it's replaced with something a client trusts) reusing the *same*
`WWWSVR1PROXY` ring already trusted for the outbound z/OSMF proxy leg —
important, see the gotcha below on why it must be the same ring, and why the
`CONNECT` above deliberately omits `DEFAULT`.

**httpd.conf — final working block** (appended after the existing
`SSLProxyCheckPeerCN Off` line from the section above):
```
Listen 8443
<VirtualHost *:8443>
    ServerName YOURHOST.example.com
    SSLEnable
    SSLServerCert WWWSVR1SRVR
</VirtualHost>
```
No `KeyFile` override inside the `<VirtualHost>` — it inherits the global
`KeyFile /saf WWWSVR1/WWWSVR1PROXY` already set for the proxy leg.
`SSLServerCert` picks the personal cert **by label** for the inbound
identity, independently of whatever the ring's `DEFAULT` cert is (or isn't).

**The gotcha that cost the most time: `DEFAULT` personal certs get offered
as client certs on the *outbound* proxy leg too, and z/OSMF rejects them.**
The obvious-looking config was to give the new `<VirtualHost *:8443>` its
*own* dedicated `KeyFile /saf WWWSVR1/WWWSVR1SRVR` ring, separate from the
proxy ring, with the new personal cert marked `DEFAULT`. That produced three
rounds of failure, each more confusing than the last:
1. First attempt (separate ring, no CA trust on it yet): outbound proxy
   calls from *within that VirtualHost* failed with `SSL0266E ... GSKit
   error 8: Certificate validation error` — proof that a `<VirtualHost>`'s
   own `SSLProxyEngine` outbound connection uses *that vhost's own*
   `KeyFile`, not the global one, even though `SSLProxyEngine`/
   `SSLProxyCheckPeerCN` were only set at global scope. Fixed by connecting
   the same `VSICA` CERTAUTH cert into the vhost's ring too.
2. Second attempt (separate ring, now with CA trust *and* the personal cert
   marked `DEFAULT`): outbound proxy calls now failed differently —
   `SSL0266E ... GSKit error 420: Socket closed by remote partner`, z/OSMF
   itself aborting the handshake. Confirmed by a control test: temporarily
   adding the same `DEFAULT` personal cert to the *original* `WWWSVR1PROXY`
   ring broke the already-working plain `:8081` proxy the same way. Root
   cause: a ring's `DEFAULT` personal cert gets opportunistically offered as
   a TLS client certificate on any outbound connection made through that
   ring, and z/OSMF's listener closes the connection outright on receiving
   an unrecognized/self-signed client cert it never asked for.
3. Fix: keep **one ring** (`WWWSVR1PROXY`) for everything, connect the
   personal server cert into it **without `DEFAULT`**, and reference it
   explicitly in the `<VirtualHost>` via `SSLServerCert WWWSVR1SRVR`. A
   non-default personal cert sitting in the ring doesn't get auto-offered
   as a client cert, but `SSLServerCert` can still pick it by label for the
   inbound (browser-facing) identity. This is the config shown above, and
   it's what's live now.

**Verified end to end (2026-08-02):**
- `GET https://yourhost.example.com:8443/zosmf/info` → 401 without credentials
  (proves the proxy leg survives the SSL-terminating vhost), real z/OSMF
  response with them.
- `POST https://yourhost.example.com:8443/zosmf/services/authenticate` with
  Basic auth → 200, `Set-Cookie: LtpaToken2=...; Path=/; Secure; HttpOnly`.
- Reusing that cookie (`Cookie: LtpaToken2=...`) against
  `GET https://yourhost.example.com:8443/zosmf/restfiles/ds?dslevel=YOURID.*`
  → 200 with real dataset list. **The Secure-cookie problem is resolved** —
  the full login → cookie → authenticated-call flow now works because
  everything happens over HTTPS.
- `zos/site/index.html`'s "Open the Console" link updated from a relative
  `console/` to an absolute `https://yourhost.example.com:8443/console/`,
  redeployed, verified byte-identical against the live copy.
- The plain `:8081` proxy still works unchanged (401/real-JSON as before) —
  the fix didn't regress it.

Same operational gotcha as before applied at every step here too: each
`httpd.conf`/keyring change needed WWWSVR1's actual httpd master
force-killed (`ps -ef` → `kill -9` via a submitted BPXBATCH job, confirmed
clean via a second `ps -ef`) before asking an authorized operator to issue a real
`S WWWSVR1` — `ACTION='STOP'`/plain start alone does not reliably cycle the
detached master process.

## Confirmed test log (2026-07-31)

All against `YOURID.*`/job names owned by yourid, all cleaned up afterward:

- Dataset: allocate (POST, 201) → write member (PUT, 201) → read (GET, 200)
  → list members (GET, 200) → copy member (PUT request=copy, 200) → delete
  member (DELETE, 204) → allocate `like` (POST, 201) → **whole-PDS copy via
  a single PUT failed** (rc=8, "'to' data set organization is partitioned,
  sequential data set expected" — the API only merges PS-to-PS in one call)
  → per-member copy loop confirmed as the working substitute → delete both
  test datasets (DELETE, 204 each) → confirmed gone.
- Job: submit via `PUT /zosmf/restjobs/jobs` with JCL as a **raw text body**
  (no form-encoding, no `~` sentinel needed) → job ran with **no USER=/
  PASSWORD= on the job card** — it ran as YOURID because that's who
  authenticated → listed spool files → read JESMSGLG → purge (DELETE, 200)
  → confirmed gone from the queue.
- Session: Basic-auth login → LtpaToken2 cookie → reused cookie-only for
  every subsequent call, including the ones above → logout invalidated it.
- Verified the whole `zos/lib` module (not just raw curl) end to end with a
  standalone Node script exercising every function; all passed, nothing
  left behind on the system afterward.

## Decisions settled since (2026-07-31, continued)

- **RACF authority for yourid: SPECIAL** (see "Decisions" above) — settled,
  the protected-HLQ guardrail carries forward into `zos/console` regardless
  of what SAF would technically allow.
- **Console hosting: z/OS**, via the IHS instance at `/etc/wwwsvr1`,
  `DocumentRoot /etc/wwwsvr1/htdocs`, port 8081 — settled.
- **`zos/auth`: just a login form** — settled once the IHS reverse-proxy
  solved the CORS/Origin problem. No custom backend process needed; see the
  IHS section above.

## Status

`zos/lib` (client, datasets, jobs) is built and live-tested. The IHS reverse
proxy to z/OSMF is live on `:8081` (HTTP) and `:8443` (HTTPS). `zos/site`
(landing page) and `zos/console` (login page + Explorer-style
dataset/jobs UI) are both built and deployed to
`/etc/wwwsvr1/htdocs/{index.html,console/}`, verified byte-identical
against the live copies (non-ASCII characters checked and fixed before each
deploy — see the EBCDIC-mangling gotcha in `source/README` history, which
still applies to the Files REST API's text PUT the same way it applied to
the old FTP path). The Secure-cookie-over-HTTP problem is resolved by the
`:8443` HTTPS vhost above; the full login → cookie → authenticated-call flow
is confirmed working end to end. The console's public entry point is
`https://yourhost.example.com:8443/console/`, linked from the landing page.

The console editor also has syntax highlighting, a line-number gutter,
and a format-aware column ruler (col 72/80 markers for JCL/ASM) — hand-rolled,
zero dependencies: a transparent `<textarea>` sits on top of a highlighted
`<pre>`, scroll-synced. See `highlightCode`/`buildRuler`/`guessFormat` in
`zos/console/console.js`.

The UI was later reworked into a persistent Zowe-Explorer-style sidebar
(Data Sets / USS / Jobs, each collapsible and resizable, plus a nested
Favorites node per view), with context menus expanded toward Explorer
parity (encoding picker, attributes, compare/diff, download, operator
commands via z/OSMF's Console REST API) and a real USS file browser
(`zos/console/console.js`'s `ussList`/`ussRead`/`ussWrite`/`ussCreate`/
`ussDelete`/`ussChmod` wrappers against `/zosmf/restfiles/fs`).

Rebranded from "Mainframe Console" to **z/OS Gateway** (display
text only — `zos/console/index.html`, `login.html`, and the top-of-file
comment in `console.js`). The URL path is unchanged (still
`/console/`, i.e. `https://yourhost.example.com:8443/console/`) — renaming the
path would mean moving the live USS directory and updating every link, and
That was kept stable. `zos/site/index.html` was rewritten from a
generic corporate landing page into a product showcase for the Gateway,
including a section on how the demo environment itself is hosted (a TAZ
ODE — Test Accelerator for Z On-Demand Environment — on Red Hat, in front
of the real z/OS instance).

Open/remaining:
- The `:8443` cert is self-signed — browsers will show a trust warning
  until it's either accepted once per browser or replaced with
  something backed by a real/internal CA.
- `zos/uss.*` (USS Files REST API wrapper) not started — only needed if a
  future feature requires USS file access from the console; confirmed live
  if/when needed.

## VSAM and zFS creation (2026-08-05)

The New Dataset modal (`console/index.html` `#newDsModal`, wired up in
`console/console.js`) only ever offered PO/PS, both allocated via a single
z/OSMF Files REST call (`dsAllocate` → `POST /zosmf/restfiles/ds/{dsn}`).
That endpoint's `dsorg` only accepts `PO`/`PS` — it has no concept of a VSAM
cluster or a zFS aggregate, so those can't be added by just extending the
same call with new attributes.

**First version (superseded same day):** submitted IDCAMS `DEFINE CLUSTER`
and `IOEAGFMT` as batch JCL through the Jobs REST API — the same
submit/toast pattern `runRexx()`/`submitAsJCL()` use elsewhere in
`console.js`. It worked but was asynchronous (had to poll the Jobs section
for the result) and needed a hand-rolled fixed-column JCL continuation
helper (`wrapJclCard()`) to handle `IOEAGFMT`'s `PARM=` line overflowing 71
columns once the dataset name got long.

**Current version:** checking z/OSMF's own API Explorer
(`https://yourhost.example.com:10443/zosmf/api/explorer/`) turned up
purpose-built synchronous REST endpoints for both, so the JCL approach was
dropped entirely:
- **VSAM** → `PUT /zosmf/restfiles/ams` ("Access Method Services
  Interface"). Runs IDCAMS commands directly — body
  `{"input": ["DEFINE CLUSTER (NAME(dsn) INDEXED CYL(1 1) KEYS(10 0)
  RECORDSIZE(80 80))"], "JSONversion": 1}`, returns 200 if IDCAMS RC ≤ 4.
  Cluster type maps to IDCAMS keywords the same way as before: KSDS→
  `INDEXED` (adds `KEYS(len offset)`), ESDS→`NONINDEXED`, RRDS→`NUMBERED`,
  Linear→`LINEAR` (no `RECORDSIZE`). Since the command travels as a JSON
  string rather than an 80-byte card image, there's no 72-column limit to
  work around — the whole `DEFINE CLUSTER` is one array element, one line,
  no continuation logic needed at all. No `VOLUMES()` clause is specified —
  relies on SMS auto-assigning storage via ACS routines the same way a
  plain PO/PS allocate already does on this system.
- **zFS** → `POST /zosmf/restfiles/mfs/zfs/{file-system-name}` ("Create
  z/OS UNIX zFS Filesystem") — purpose-built for exactly this, body
  `{"cylsPri": n, "cylsSec": n, "JSONversion": 1}`, 201 on success. z/OSMF
  handles the allocate-and-format itself; no `IOEAGFMT` batch job needed.
  (The Filesystem APIs group also has `GET /zosmf/restfiles/mfs` to list
  mounted filesystems, `PUT /zosmf/restfiles/mfs/{name}` to mount/unmount,
  and `DELETE /zosmf/restfiles/mfs/zfs/{name}` to delete one — none wired
  up yet, but confirmed available if a future feature needs them.)
- Both are synchronous, so creation behaves like PO/PS again: the modal
  closes and the tree refreshes immediately — no job to go check, no
  `wrapJclCard()`/job-card/jobname plumbing to maintain.
- The client-side protected-HLQ guardrail (`isProtected()` /
  `PROTECTED_HLQ`, previously only checked on delete) is now also checked
  in the New Dataset modal for **all four** types, PO/PS included — it
  wasn't guarded before this change. Consistent with the "if anything more
  strictly" carry-forward decision noted above, given RACF SPECIAL gives no
  safety net here either way.

**Not live-tested against yourhost.example.com.** The request shapes above are
taken directly from this system's own API Explorer output (so the endpoint
paths/body schema are correct for this exact z/OSMF instance), but this
system's SMS setup (storage classes, ACS routines, whether any non-SMS
volumes on this catalog need an explicit `VOLUMES()` on the IDCAMS side) is
still unverified from here — unlike everything else in this doc, which was
confirmed live before being written up as settled. Test with a disposable
dataset name first (e.g. `YOURID.TEST.KSDS`) before trusting this against
anything real.

`zos/lib` (the Node-side library) was deliberately **not** extended with
VSAM/zFS equivalents — same precedent as `runRexx()`, which also only
exists in `console.js` and has no `zos/lib` counterpart.

## Jobs panel: Zowe Explorer parity (2026-08-07)

Scoped from three screenshots of the Zowe Explorer VS Code extension's Jobs
tree context menu and "Search Jobs" quick-pick. Five of the items were
selected for this pass; two were deliberately skipped:

- **Skipped — Manage Profile**: there's only ever one profile (this
  console talks to exactly one z/OSMF instance), so a profile-switcher has
  nothing to manage.
- **Skipped — Show as Table**: the tree view is the only jobs UI this
  console has; a second table-based view would duplicate `renderJobNode()`
  and the tree/table would drift out of sync for no real benefit at this
  size of job list.

Implemented, all in `console/index.html` + `console/console.js` (no new
z/OSMF endpoints beyond what was already confirmed live):

- **Structured Search Jobs** — new popover (`#jobSearchPop`, same
  positioned-`.popover` pattern as USS's `#ussFilterPop`) with Owner,
  Prefix, and Status fields, opened from a new magnifying-glass icon button
  in the Jobs toolbar. `jobsList()` was rewritten from a single hardcoded
  `owner=*` prefix search to `jobsList(owner, prefix, status)`. Owner and
  prefix are real server-side filters (`/zosmf/restjobs/jobs?owner=...&prefix=...`,
  both accept `*`/`?` wildcards). Status is not: z/OSMF's `status` query
  param only recognizes the literal `ACTIVE` — anything else is silently
  ignored server-side — so OUTPUT/INPUT filtering happens client-side
  against the `status` field already present on each returned job document.
  The original single-box `#jobFilter`/`#jobsListBtn` quick filter still
  works as before (prefix-only, owner=*, no status filter); the new popover
  is additive, not a replacement.
- **Search history** — `#jobSearchRecentList`, same `localStorage`-backed
  recent-list pattern as USS's `USS_RECENT_KEY`/`renderUssRecent()`, keyed
  as `isiJobSearchRecent`. Each entry stores the full `{owner, prefix,
  status}` triple (not just a path string like USS), rendered as one
  summary line per search; clicking a recent entry re-runs it.
- **Start Polling Active Jobs** — toggle button in the Jobs toolbar,
  `setInterval(refreshJobTree, 10000)` while on. Deliberately simpler than
  the SYSLOG tab's poll loop (`pollSyslog`/`SYSLOG_POLL_MS`): there's no tab
  lifetime to track since this drives the always-present sidebar tree
  rather than a tab, so it's just a plain on/off interval with no
  "tab was closed, stop polling" cleanup needed. Re-runs whatever
  owner/prefix/status filter is currently active on each tick.
- **Sort Jobs** — a plain `<select>` in the toolbar (Default / Job ID /
  Name / Return Code), applied client-side via `sortJobRows()` after every
  `jobsList()` call. Not a z/OSMF-side sort — the REST API doesn't offer
  one, and the job counts here don't warrant asking it to.
- **Issue TSO Command** — new "TSO…" button in the Jobs toolbar. Uses
  z/OSMF's newer single-call TSO/E API, `PUT /zosmf/tsoApp/v1/tso` with
  body `{"tsoCmd": "..."}`, which starts a TSO address space, runs the one
  command, and tears the session down again in one round trip — chosen
  over the older stateful start/send/ping/end session API (4 separate
  calls, plus an unusual literal-JSON-as-text-string body format for the
  "send" step) since a single fire-and-forget command is all this button
  needs. Runs under the logged-in user's own TSO authority, not operator-
  console authority — a different risk category than `consoleCmd()`'s MVS
  console commands — but still real system power, so it gets the same
  `prompt()` + `confirm()`-before-send treatment as `issueModifyCommand()`/
  `issueStopCommand()`/`issueCustomCommand()`, and reuses the existing
  `showInfoModal()` (originally built for Show Attributes) to display the
  command's response text rather than adding a new modal.

**Not live-tested against yourhost.example.com.** The Jobs owner/prefix/status
query parameters were confirmed against the live API Explorer earlier this
session, but the TSO/E `v1/tso` endpoint's exact response shape
(`cmdResponse[].message`) is taken from IBM's REST API docs, not from a
live call against this system — no zosmf credentials were available in
this session to exercise it. Test "Issue TSO Command" with something
harmless first (e.g. `TIME` or `LISTALC`) before relying on it for

## USS rename (2026-08-10)

An earlier comment in `console.js`'s USS REST wrappers section claimed
z/OSMF's Files API had no atomic rename for USS files/directories, and
that a copy+delete pair was skipped as "a bigger footgun for USS since
there's no verify-before-delete story for directories the way
`dsCopyMember` gives us for datasets." That claim turned out to be wrong
(or the API gained this since it was written) — confirmed against IBM's
own [z/OSMF Ansible collection source](https://github.com/IBM/ibm_zos_zosmf/blob/master/plugins/modules/zmf_file.py)
(`zmf_file.py`'s `operate_file_action()`, `action == 'move'` branch): a
single `PUT` to the **new** path with body `{"request": "move", "from":
"<old path>"}` performs an atomic rename/move, for both files and
directories — no recursive copy needed for a directory rename, unlike
the dataset-rename copy+delete pattern `renameItem()` uses.

Added `ussRename(oldPath, newPath)` (`console.js`) and a `Rename...` /
`Rename folder...` entry in the USS context menu (`showUssCtx`), right
before Delete, matching the dataset menu's Rename→Delete ordering. Open
tabs pointing at the renamed path (or, for a directory rename, anything
nested underneath it) are updated in place rather than left dangling.
Not yet exercised against the live system from this session (no zosmf
credentials available here) — the request shape is taken directly from
IBM's own Ansible module source, but test with a disposable file/folder
first before trusting it against anything real.

## zFS mount (2026-08-10)

Added a "Mount as zFS..." dataset context menu entry, using
`PUT /zosmf/restfiles/mfs/{file-system-name}` ("Mount/Unmount a UNIX file
system") — verified against this system's own live API Explorer
(`Filesystem_APIs > MountUnixFile` at
`https://yourhost.example.com:10443/zosmf/api/explorer/`), not just IBM's
generic docs, per this project's usual practice of checking the live
Swagger output before implementing. Request body:

```json
{ "action": "mount", "mount-point": "<uss path>", "fs-type": "ZFS", "mode": "rdonly" }
```

`mode` is `rdonly` (default, offered as Cancel in the confirm prompt) or
`rdwr` (OK). 204 with no content on success. `fs-type` must match the
`TYPE` operand on the target `FILESYSTYPE` statement in `BPXPRMxx` — `ZFS`
is correct for a zFS-formatted linear dataset, which is what this menu
item targets. z/OSMF does **not** create the mount-point directory itself
— it must already exist in USS (same "create the path first" caveat the
README's upload instructions call out for `curl`/`zowe zos-files upload`
against a nonexistent directory).

Added `mountZfs(dsn, mountPoint, mode)` and `mountZfsPrompt(dsn)`
(`console.js`, right after `createZfs()` in the "VSAM / zFS creation"
section), and wired `showCtx()` to accept a new `kind` argument (already
computed by `renderDsNode()` via the existing `dsKind()` classifier) so
the menu item only appears on dataset-tree rows `dsKind()` already
classifies as `'vsam'`.

Also added the inverse `unmountZfs(dsn)` / `unmountZfsPrompt(dsn)` and an
"Unmount zFS..." entry right next to "Mount as zFS..." — same PUT
endpoint, `{"action":"unmount"}` body (the API Explorer's model shows
`action` as a single `['mount','unmount']` enum on one shared request
body, no separate unmount operation). The model doesn't expose a
force/immediate unmount option the way the z/OS `UNMOUNT` console command
does (`NORMAL`/`IMMEDIATE`/`FORCE`/`DRAIN`/`RESET`) — unmounting a
filesystem that's still busy just fails cleanly through
`friendlyZosmfError()` like everything else, with no escalation path
offered from the console.

**Known limitation:** `dsKind()` classifies by `dsorg` alone (any
`VS`-prefixed `dsorg` → `'vsam'`), and zFS filesystems are themselves VSAM
linear datasets under the hood — the dataset-list REST API's base
attributes don't expose a "this VSAM is actually zFS-formatted" flag to
distinguish a zFS cluster from a KSDS/ESDS/RRDS/LDS at list time. So
"Mount as zFS..." is offered on every VSAM-classified row, not just true
zFS ones. Attempting to mount a non-zFS VSAM cluster fails cleanly with a
z/OSMF error (routed through the existing `friendlyZosmfError()` toast),
so this was judged an acceptable trade-off over adding a second API round
trip (e.g. LISTCAT) per VSAM row just to gate a context-menu item — but
worth tightening later if it causes confusion in practice.

Not yet exercised against the live system from this session (no zosmf
credentials available here) — the request shape is taken directly from
the live API Explorer's own Model/Example Value output for this
operation, but test against a disposable zFS (e.g. one created via "New
Dataset... > ZFS") mounted to a scratch directory before trusting it
against anything real.

## SYSLOG selection/copy bugs (2026-08-11)

Reported over a few rounds as "highlighting doesn't select properly", then
"the text I selected isn't the text that pasted", then "can't select the
last line" — three distinct bugs in the same area, found and fixed one at
a time:

1. **Spurious keyword coloring on plain text.** `highlightCode()` had no
   early return for `fmt === 'plain'` (used by SYSLOG and job spool tabs),
   so it fell through to `tokenizeSegment()` built from the JCL/REXX
   keyword list regardless of format — ordinary SYSLOG words like `TO`,
   `JOB`, and `VOL` are all real REXX/JCL keywords and were getting wrapped
   in colored `<span>`s. Purely cosmetic, but sitting under the selection
   highlight it made selected text look inconsistent/broken. Fixed with an
   early `if (fmt === 'plain') return escHtml(text) || '&nbsp;';`.
2. **Selected text not matching pasted text.** `appendSyslogToEditor()`
   (the 5-second live-poll refresh) reassigns `area.value` in place to
   avoid the full `renderEditorFor()` reset. Reassigning `.value` doesn't
   reliably preserve `scrollTop` across browsers, and `#edHl` (the visible
   colored overlay) only ever gets its scroll position *from*
   `area.scrollTop` afterward — so if the real scroll position drifted by
   even a little during the reassignment, the overlay and the actual
   (invisible) textarea underneath could end up showing different lines at
   the same screen position, while looking perfectly aligned. Fixed by
   explicitly saving `scrollTop`/`scrollLeft` before the reassignment and
   restoring them after (when not auto-following the tail).
3. **Can't select the last line.** The existing guard only skipped the
   live-refresh while `selectionStart !== selectionEnd` (an actual dragged
   range) — it didn't cover the instant *before* a range exists, i.e. the
   moment of clicking down to start a drag. That's exactly the worst spot
   for it: sitting at the bottom of the tail to select the last line is
   also exactly where a poll tick is most likely to land mid-click and
   auto-follow-jump the view to a new bottom, moving the target out from
   under the mouse. Widened the guard to `document.activeElement === area
   || area.selectionStart !== area.selectionEnd` — live updates now pause
   for the entire time the SYSLOG textarea is focused, not just once a
   range is dragged out. `t.text` keeps accumulating in the background
   regardless; new lines appear on the next tick after focus leaves.

None of the three above were tested against the live system when written —
verified by static code reading against the reported screenshots, not by
reproducing interactively. They were real bugs and worth fixing, but they
weren't *the* bug: the report persisted after all three shipped.

**4. The actual root cause: `#edHl` and `#editorArea` rendering at
different heights for identical text.** With live browser access (the console
was opened and signed in; inspected via the Chrome DevTools
Protocol rather than guessing further), direct DOM measurement on the
live SYSLOG tab showed `#editorArea.scrollHeight` (4045px) and
`#edHl.scrollHeight` (4026px) disagreeing by ~19px - almost exactly one
line (`line-height: 19.5px`) - despite `area.value === edHlCode.textContent`
being confirmed byte-for-byte identical. Both elements were independently
scrolled to "the bottom" (area explicitly via `scrollTop = scrollHeight`
in `appendSyslogToEditor`/`openSyslogTab`; `#edHl` by `syncEditorScroll`
copying `area.scrollTop`) - but `#edHl`'s own max scroll position is
smaller than `area`'s, so the browser silently clamps `hl.scrollTop` to a
value that shows an *earlier* window of lines than what's actually
selectable in the textarea underneath. That's the real explanation for
every round of this bug: selecting the last line is exactly where this
clamp bites, since that's where the two elements' scroll ranges diverge
the most.

Root cause of the height difference itself: `t.text` always ended in a
trailing `"\n"` (`items.map(formatSyslogLine).join('\n') + '\n'`). A
`<textarea>` reserves a full line-height for the phantom empty line after
a trailing newline; the `<pre><code>` overlay does not grow by the same
amount for an identical string. Confirmed directly: manually stripping the
trailing `\n` from both `area.value` and `hlCode.textContent` in the live
DOM made `scrollHeight` match exactly (4026px both) before writing the
fix.

Fixed in `openSyslogTab()` and `pollSyslog()`: `t.text` is now built
without ever ending in `"\n"` - the initial load has no trailing newline,
and each poll's append prepends `"\n"` as a separator (`t.text += '\n' +
newLines`) instead of trailing it after every batch. Verified live via the
same DOM-measurement approach before deploying.

## Sidebar section height stuck after collapsing siblings (2026-08-11)

Reported as two symptoms that turned out to be the same bug: collapsing
sections no longer "dropped to the bottom" the way they used to, and the
Jobs section was too short to show an expanded job's spool file list with
no way to resize it bigger.

Root cause was in `applySideHeights()`: a section with a saved height from
a previous manual drag (`sideHeights[sec.id]`, persisted in
`localStorage`) was given `flex: 0 1 <px>` — flex-grow:0. That pins it at
exactly that pixel height forever, even after its siblings get collapsed
and leave the rest of the sidebar empty below it, because flex-grow:0
means "never grow past your basis." Worse, once a section is the *only*
open one, there's no adjacent open sibling left for the `.sideResizer`
drag handler to trade height with (`nearestOpenSection()` finds nothing),
so manual resize was a dead end too in that state.

Fix: changed both `applySideHeights()`'s saved-height branch and the
`.sideResizer` drag handler's live `onMove` updates from `flex: 0 1 <px>`
to `flex: 1 1 <px>` — flex-grow:1. The saved height still acts as the
starting/preferred size, but the section can now grow to actually claim
whatever space its collapsed-away neighbors freed up, same as a section
with no saved height at all. Anyone who already has an old small height
saved for a section in their browser's `localStorage` will see it
immediately start filling free space correctly the next time they
collapse/expand any section (no need to clear `isiSideHeights`).
anything that matters.
