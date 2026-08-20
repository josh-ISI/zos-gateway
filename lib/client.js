// TK5-tools → z/OS 3.2 — z/OSMF REST client (no npm dependencies, matches
// the style of ../../auth-proxy/auth-service.js).
//
// Handles the three things every single call to this z/OSMF instance needs
// (confirmed live against yourhost.example.com on 2026-07-31 — see
// ../ARCHITECTURE.md for what was tested vs. assumed):
//   1. Origin + Referer headers — without them z/OSMF rejects every request
//      with IZUG846W ("remote site ... not permitted"), even though this is
//      not a real network/VPN check, just a header presence check.
//   2. X-CSRF-ZOSMF-HEADER on any state-changing call (POST/PUT/DELETE).
//   3. Session via LtpaToken2 cookie, traded for once at login (POST
//      /zosmf/services/authenticate with Basic auth) and reused after that
//      — so the plaintext password only has to be held for that one call,
//      not for the life of the session.
"use strict";
const https = require("https");
const { URL } = require("url");

class ZosmfError extends Error {
  constructor(message, detail, status) {
    super(message);
    this.name = "ZosmfError";
    this.detail = detail;
    this.status = status;
  }
}

class Zosmf {
  constructor({ baseUrl, rejectUnauthorized = false } = {}) {
    if (!baseUrl) throw new Error("Zosmf: baseUrl required, e.g. https://yourhost.example.com:10443");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.rejectUnauthorized = rejectUnauthorized; // z/OSMF here uses a cert curl -k accepts; flip on once you have the real CA
    this.cookie = null; // "LtpaToken2=..." once logged in
  }

  // ---- low-level request ----------------------------------------------
  _request(method, path, { body, headers = {}, auth, raw } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const h = Object.assign(
        {
          Origin: this.baseUrl,
          Referer: this.baseUrl + "/zosmf/",
        },
        headers
      );
      if (["POST", "PUT", "DELETE"].includes(method)) h["X-CSRF-ZOSMF-HEADER"] = "true";
      if (this.cookie) h["Cookie"] = this.cookie;
      if (auth) h["Authorization"] = "Basic " + Buffer.from(auth.user + ":" + auth.pass).toString("base64");

      let payload;
      if (body !== undefined) {
        payload = typeof body === "string" ? body : JSON.stringify(body);
        if (!h["Content-Type"]) h["Content-Type"] = typeof body === "string" ? "text/plain" : "application/json";
        h["Content-Length"] = Buffer.byteLength(payload);
      }

      const req = https.request(
        {
          method,
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          headers: h,
          rejectUnauthorized: this.rejectUnauthorized,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            // capture LtpaToken2 from any response that sets one (login, or
            // a token refresh) — later calls just reuse this.cookie
            const setCookie = res.headers["set-cookie"];
            if (setCookie) {
              const ltpa = setCookie.map((c) => c.split(";")[0]).find((c) => c.startsWith("LtpaToken2="));
              if (ltpa) this.cookie = ltpa;
            }
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode;
            if (raw) return resolve({ status, text, headers: res.headers });

            let json = null;
            if (text && /json/i.test(res.headers["content-type"] || "")) {
              try {
                json = JSON.parse(text);
              } catch (e) {
                /* z/OSMF sometimes sends text/plain even for JSON-shaped errors */
              }
            }
            if (status >= 400) {
              const msg =
                (json && (json.message || (json.details && json.details.join("; ")))) || text || "HTTP " + status;
              return reject(new ZosmfError(msg, json || text, status));
            }
            resolve({ status, json, text, headers: res.headers });
          });
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ---- session ----------------------------------------------------------
  // Trades user/pass for a session cookie. Confirmed: POST with Basic auth
  // returns {"returnCode":0,...} plus a Set-Cookie: LtpaToken2=... header.
  async login(user, pass) {
    await this._request("POST", "/zosmf/services/authenticate", { auth: { user, pass } });
    if (!this.cookie) throw new ZosmfError("login succeeded but no LtpaToken2 was returned", null, 200);
  }

  async logout() {
    if (!this.cookie) return;
    await this._request("DELETE", "/zosmf/services/authenticate").catch(() => {});
    this.cookie = null;
  }

  // Exposed for the jobs/datasets modules — they don't need to know about
  // Origin/Referer/CSRF/cookies, just method+path+body.
  raw(method, path, opts) {
    return this._request(method, path, opts);
  }
}

module.exports = { Zosmf, ZosmfError };
