// Thin wrapper over z/OSMF's Files REST API (/zosmf/restfiles/ds/...).
// Every function here was exercised live against yourhost.example.com on
// 2026-07-31 under YOURID.ZOSTEST.* (allocated, written, copied, deleted —
// nothing left behind). See ../ARCHITECTURE.md for the full test log.
//
// This replaces WEBADM.rexx's save action, and the exDeleteMember /
// exCopyWholePds / exAllocLike JCL-generation dance in the old
// source/console.js — no temp datasets, no IEBCOPY EXCLUDE, no hand-sized
// SPACE= guesses, no ordering bug to have in the first place. SAF checks
// the actual authority server-side on every call.
"use strict";

function enc(s) {
  return encodeURIComponent(s);
}
// A member reference is "DSN(MEMBER)" — encode the whole thing as one path
// segment, parens included, same as z/OSMF expects.
function target(dsn, member) {
  return member ? `${dsn}(${member})` : dsn;
}

// ---- list datasets under a level, e.g. "YOURID.*" or "SYS1.**" ----------
async function list(zosmf, dslevel) {
  const r = await zosmf.raw("GET", `/zosmf/restfiles/ds?dslevel=${enc(dslevel)}`);
  return (r.json && r.json.items) || [];
}

// ---- list members of a PDS ------------------------------------------------
// Confirmed: 200 with items:[] for an empty PDS (unlike TK5's /dsl/pds,
// which 404s on empty — no special-casing needed here).
async function listMembers(zosmf, dsn) {
  const r = await zosmf.raw("GET", `/zosmf/restfiles/ds/${enc(dsn)}/member`);
  return ((r.json && r.json.items) || []).map((i) => i.member);
}

// ---- read a member or a whole PS dataset ----------------------------------
async function read(zosmf, dsn, member) {
  const r = await zosmf.raw("GET", `/zosmf/restfiles/ds/${enc(target(dsn, member))}`, { raw: true });
  return r.text;
}

// ---- write (create-or-replace) a member or a whole PS dataset -------------
async function write(zosmf, dsn, member, text) {
  await zosmf.raw("PUT", `/zosmf/restfiles/ds/${enc(target(dsn, member))}`, {
    body: text,
    headers: { "Content-Type": "text/plain" },
  });
}

// ---- allocate ---------------------------------------------------------
// attrs is either explicit attributes:
//   {dsorg:"PO", alcunit:"TRK", primary:1, secondary:1, dirblk:5,
//    recfm:"FB", lrecl:80, blksize:3120}
// or, to inherit attributes from an existing dataset (confirmed working —
// this is the replacement for exAllocLike's DCB=(likeDsn) referback):
//   {like: "SOME.EXISTING.DSN"}
async function allocate(zosmf, dsn, attrs) {
  await zosmf.raw("POST", `/zosmf/restfiles/ds/${enc(dsn)}`, { body: attrs });
}

// ---- delete a member, or an entire dataset if member is omitted -----------
// Confirmed: 204 on success. This is one SAF-checked call — no temp
// dataset, no copy-out/verify/delete-original ordering to get wrong (that
// ordering bug is what wiped SYS1.PROCLIB on the TK5 side; it structurally
// can't happen here because there's no client-side rebuild step at all).
async function deleteDataset(zosmf, dsn, member) {
  await zosmf.raw("DELETE", `/zosmf/restfiles/ds/${enc(target(dsn, member))}`);
}

// ---- copy a single member, or a whole sequential dataset (member omitted
// on both sides) ----------------------------------------------------------
// Confirmed working. `replace` controls whether an existing target member
// is overwritten (needed for copyWholePds's use case, below).
async function copyMember(zosmf, fromDsn, fromMember, toDsn, toMember, replace) {
  await zosmf.raw("PUT", `/zosmf/restfiles/ds/${enc(target(toDsn, toMember))}`, {
    body: {
      request: "copy",
      "from-dataset": fromMember ? { dsn: fromDsn, member: fromMember } : { dsn: fromDsn },
      replace: !!replace,
    },
  });
}

// ---- copy an entire PDS's members into another PDS -------------------
// IMPORTANT, confirmed by testing: z/OSMF's copy request does NOT merge all
// members of a source PDS into a target PDS in one call — passing
// {"from-dataset":{"dsn": sourcePds}} with no member, against a PO target,
// fails with rc=8 "'to' data set organization is partitioned, sequential
// data set expected". The API's whole-dataset copy only means PS-to-PS.
// So a whole-PDS copy is: allocate the destination (typically `like` the
// source, if it doesn't exist yet — see allocate() above), then loop a
// per-member copy. That's what this does. Caller is responsible for making
// sure toDsn already exists.
async function copyWholePds(zosmf, fromDsn, toDsn) {
  const members = await listMembers(zosmf, fromDsn);
  for (const m of members) await copyMember(zosmf, fromDsn, m, toDsn, m, true);
  return members;
}

module.exports = { list, listMembers, read, write, allocate, deleteDataset, copyMember, copyWholePds };
