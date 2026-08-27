#!/bin/sh
#
# httpd-start.sh - config-integrity guard wrapper around apachectl.
#
# Deployed to $DIR/bin/httpd-start.sh and invoked from the WWWSVR1
# started-task proc instead of calling apachectl directly.
#
# Why this exists
# ---------------
# httpd.conf has come back zero-length after an IPL more than once.
# Zero-length, not reverted-to-an-older-copy, is the signature of an
# interrupted write rather than anything overwriting the file: zFS
# buffers writes and only flushes them on its sync interval or on a
# clean unmount/quiesce, so a truncate-then-rewrite of httpd.conf whose
# truncate reached disk but whose content did not will leave exactly
# this behind when the system goes down without zFS getting to flush.
#
# This script does NOT fix that root cause - the real fixes are a clean
# shutdown/unmount sequence before IPL and, if that cannot always be
# guaranteed, a shorter SYNC_INTERVAL in IOEFSPRM. What it does is stop
# a zero-length config from turning into a failed server start plus a
# manual recovery: it restores from the known-good backup automatically
# and says loudly, in the proc output, that it had to.
#
# It also maintains that backup, but only refreshes it when the live
# config actually passes "apachectl -t" - so a config that is present
# but broken can never quietly overwrite the last known-good copy.
#
# Arguments (all positional, supplied by the proc's symbolics):
#   $1  server root directory   e.g. /etc/wwwsvr1
#   $2  apachectl action        e.g. start | stop | restart
#   $3  config file, relative to server root, e.g. conf/httpd.conf
#
# Exits non-zero if the config is unusable and no good backup exists,
# so the started task fails visibly instead of starting misconfigured.
# BPXBATCH surfaces that exit code as the step's return code.

DIR="$1"
ACTION="$2"
CONF="$3"

if [ -z "$DIR" ] || [ -z "$ACTION" ] || [ -z "$CONF" ]; then
  echo "httpd-start.sh: usage: httpd-start.sh <serverroot> <action> <conffile>" >&2
  exit 16
fi

APACHECTL="$DIR/bin/apachectl"
CONF_PATH="$DIR/$CONF"
BKUP="$CONF_PATH.bkup"
PREV="$CONF_PATH.bkup.prev"

log() {
  echo "httpd-start.sh $(date '+%Y-%m-%d %H:%M:%S'): $*"
}

# The guard only makes sense on the way up. A stop/restart of an already
# running server must not be delayed or blocked by config checks - pass
# those straight through untouched.
if [ "$ACTION" != "start" ]; then
  exec "$APACHECTL" -k "$ACTION" -f "$CONF" -DNO_DETACH
fi

# ---- 1. Is the live config usable at all? ----
# -s is true only for a file that exists AND has non-zero size, which
# covers both the "file vanished" and the "file is 0 bytes" cases in one
# test - the zero-byte case being the one actually seen after an IPL.
if [ ! -s "$CONF_PATH" ]; then
  if [ -s "$BKUP" ]; then
    log "WARNING: $CONF_PATH is missing or zero-length - restoring from $BKUP"
    if cp "$BKUP" "$CONF_PATH"; then
      log "WARNING: restore succeeded. Investigate why the config was lost;"
      log "WARNING: this usually means the system went down without zFS flushing."
    else
      log "FATAL: restore from $BKUP failed - not starting."
      exit 12
    fi
  else
    log "FATAL: $CONF_PATH is missing or zero-length and $BKUP is unusable."
    log "FATAL: not starting - restore a good httpd.conf by hand first."
    exit 12
  fi
fi

# ---- 2. Does it actually parse? ----
# Size alone does not prove the file is valid, so let httpd itself be the
# judge. This is also what gates the backup refresh below.
if "$APACHECTL" -t -f "$CONF" >/dev/null 2>&1; then
  CONF_OK=yes
else
  CONF_OK=no
  log "WARNING: $CONF_PATH failed the apachectl syntax check."
fi

# A present-but-broken config is worth trying to recover from too, but
# only when the backup is demonstrably better - never swap a broken file
# for another broken file.
if [ "$CONF_OK" = "no" ] && [ -s "$BKUP" ]; then
  if "$APACHECTL" -t -f "$CONF.bkup" >/dev/null 2>&1; then
    log "WARNING: backup passes the syntax check - restoring from $BKUP"
    cp "$CONF_PATH" "$CONF_PATH.bad.$(date '+%Y%m%d.%H%M%S')" 2>/dev/null
    if cp "$BKUP" "$CONF_PATH"; then
      log "WARNING: restore succeeded; the broken config was kept as .bad.<timestamp>"
      CONF_OK=yes
    fi
  else
    log "WARNING: backup does not pass the syntax check either - leaving config alone."
  fi
fi

if [ "$CONF_OK" != "yes" ]; then
  log "FATAL: no usable config - not starting."
  exit 12
fi

# ---- 3. Keep the backup current, but only from a config known to parse ----
# Rotating the old backup to .prev first means a bad refresh still leaves
# one generation of history to fall back on.
if [ ! -s "$BKUP" ] || ! cmp -s "$CONF_PATH" "$BKUP"; then
  [ -s "$BKUP" ] && cp "$BKUP" "$PREV" 2>/dev/null
  if cp "$CONF_PATH" "$BKUP"; then
    log "config backup refreshed from the running config"
  else
    log "WARNING: could not refresh $BKUP - continuing with the start anyway."
  fi
fi

# ---- 4. Hand off to apachectl ----
# exec, not a plain call, so apachectl replaces this shell rather than
# running under it - the started task then waits on httpd itself (which
# -DNO_DETACH keeps in the foreground) and its return code is httpd's,
# not this wrapper's.
log "starting httpd with $CONF_PATH"
exec "$APACHECTL" -k "$ACTION" -f "$CONF" -DNO_DETACH
