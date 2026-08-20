// Thin wrapper over z/OSMF's Jobs REST API (/zosmf/restjobs/jobs).
// Confirmed live end-to-end against yourhost.example.com on 2026-07-31: submit
// (PUT with JCL as a text body), poll status, list spool files, read
// records, purge — full round trip on job YOURIDT/JOB00078, cleaned up
// after. See ../ARCHITECTURE.md for the log.
//
// This replaces source/submit-job.ps1's sockdev card reader (3505) +
// sockdev printer (4000) capture entirely. No MSGCLASS=H vs Z distinction,
// no $S/$P printer management, no printer-stuck-on-class-Z failure mode —
// output comes back over the same HTTPS connection that submitted the job.
// Also: the job ran under YOURID's own identity with no USER=/PASSWORD= on
// the job card at all — z/OSMF authenticates the submitter and JES runs the
// job as them, so there's no HERC01-style shared service-account identity
// to design around here.
"use strict";

async function submit(zosmf, jclText) {
  const r = await zosmf.raw("PUT", "/zosmf/restjobs/jobs", {
    body: jclText,
    headers: { "Content-Type": "text/plain" },
  });
  return r.json; // {jobname, jobid, status, retcode, ...}
}

async function status(zosmf, jobname, jobid) {
  const r = await zosmf.raw("GET", `/zosmf/restjobs/jobs/${encodeURIComponent(jobname)}/${encodeURIComponent(jobid)}`);
  return r.json;
}

async function waitForOutput(zosmf, jobname, jobid, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await status(zosmf, jobname, jobid);
    if (s.status === "OUTPUT") return s;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${jobname} ${jobid} did not reach OUTPUT within ${timeoutMs}ms`);
}

async function listSpoolFiles(zosmf, jobname, jobid) {
  const r = await zosmf.raw("GET", `/zosmf/restjobs/jobs/${encodeURIComponent(jobname)}/${encodeURIComponent(jobid)}/files`);
  return r.json; // [{id, ddname, stepname, records-url, ...}, ...]
}

async function readSpoolFile(zosmf, jobname, jobid, fileId) {
  const r = await zosmf.raw(
    "GET",
    `/zosmf/restjobs/jobs/${encodeURIComponent(jobname)}/${encodeURIComponent(jobid)}/files/${fileId}/records`,
    { raw: true }
  );
  return r.text;
}

// Convenience: submit, wait for completion, read every spool file, purge —
// the equivalent of what exRunJob did in the old console.js, minus all the
// printer/MSGCLASS machinery.
async function runAndCapture(zosmf, jclText, opts) {
  const submitted = await submit(zosmf, jclText);
  const done = await waitForOutput(zosmf, submitted.jobname, submitted.jobid, opts);
  const files = await listSpoolFiles(zosmf, submitted.jobname, submitted.jobid);
  const output = {};
  for (const f of files) output[f.ddname] = await readSpoolFile(zosmf, submitted.jobname, submitted.jobid, f.id);
  await purge(zosmf, submitted.jobname, submitted.jobid);
  return { jobname: submitted.jobname, jobid: submitted.jobid, retcode: done.retcode, output };
}

async function purge(zosmf, jobname, jobid) {
  await zosmf.raw("DELETE", `/zosmf/restjobs/jobs/${encodeURIComponent(jobname)}/${encodeURIComponent(jobid)}`);
}

module.exports = { submit, status, waitForOutput, listSpoolFiles, readSpoolFile, runAndCapture, purge };
