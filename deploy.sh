#!/usr/bin/env bash
# Uploads the site to Hostinger. Nothing is built — these files are the site.
#
#   FTP (shared hosting):
#     FTP_HOST=ftp.radrebeldeveloper.com FTP_USER=uXXXXXXXX FTP_DIR=/public_html \
#     ./deploy.sh ftp
#
#   SSH (VPS, or shared plans with SSH):
#     SSH_TARGET=root@1.2.3.4 SSH_DIR=/var/www/radrebeldeveloper.com ./deploy.sh ssh
#
# The password / passphrase is never passed on the command line: FTP reads it
# from the FTP_PASS environment variable and hands it to curl over stdin, SSH
# uses your key. Set FTP_PASS in the shell for one command only:
#
#     FTP_PASS='…' FTP_HOST=… FTP_USER=… ./deploy.sh ftp
#
set -euo pipefail
cd "$(dirname "$0")"

# What actually gets served. scan.mjs, overrides.json, extras.json and README.md
# stay on your machine — they are the toolchain, not the site.
FILES=(index.html projects.json)
DIRS=(icons assets)

mode="${1:-}"

case "$mode" in
  ftp)
    : "${FTP_HOST:?set FTP_HOST}"
    : "${FTP_USER:?set FTP_USER}"
    : "${FTP_PASS:?set FTP_PASS (for this command only)}"
    base="ftp://${FTP_HOST}:${FTP_PORT:-21}${FTP_DIR:-/public_html}"

    # Explicit FTPS is required by default — an FTP password crossing the wire
    # in clear text is not worth the convenience. FTP_INSECURE=1 relaxes it.
    tls="--ssl-reqd"
    [ "${FTP_INSECURE:-}" = "1" ] && tls="--ssl"

    # Refuse to invent a directory tree. --ftp-create-dirs below will happily
    # create whatever path it is given, so if FTP_DIR is wrong the upload would
    # silently build a stray site somewhere instead of failing. List the target
    # first: no such directory, no upload.
    if ! curl $tls --disable-epsv -sS --fail --list-only "$base/" -o /dev/null --config - <<CFG
user = "${FTP_USER}:${FTP_PASS}"
CFG
    then
      echo "cannot list ${FTP_DIR:-/public_html} on ${FTP_HOST} — check FTP_DIR and the credentials" >&2
      exit 1
    fi

    upload() {   # upload <local> <remote-path>
      curl $tls --ftp-create-dirs --disable-epsv -sS --fail \
           -T "$1" "$base/$2" --config - <<CFG
user = "${FTP_USER}:${FTP_PASS}"
CFG
      echo "  ↑ $2"
    }

    for f in "${FILES[@]}"; do upload "$f" "$f"; done
    for d in "${DIRS[@]}"; do
      [ -d "$d" ] || continue
      while IFS= read -r f; do upload "$f" "$f"; done < <(find "$d" -type f)
    done
    ;;

  ssh)
    : "${SSH_TARGET:?set SSH_TARGET, e.g. root@1.2.3.4}"
    : "${SSH_DIR:?set SSH_DIR, e.g. /var/www/radrebeldeveloper.com}"

    if command -v rsync >/dev/null 2>&1; then
      rsync -av --delete-after \
        "${FILES[@]}" "${DIRS[@]}" "${SSH_TARGET}:${SSH_DIR}/"
    else
      scp -r "${FILES[@]}" "${DIRS[@]}" "${SSH_TARGET}:${SSH_DIR}/"
    fi
    ;;

  *)
    echo "usage: ./deploy.sh ftp|ssh" >&2
    exit 2
    ;;
esac

echo "done — if the page looks stale, purge the cache in hPanel (Websites → Advanced → Cache Manager)."
