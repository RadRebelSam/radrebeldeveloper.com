#!/usr/bin/env node
/**
 * Packs exactly what belongs on the server into dist/radrebeldeveloper.com.zip.
 *
 *   node pack.mjs
 *
 * scan.mjs calls this itself, so the zip is never out of step with the manifest.
 * Unzip it straight into public_html: the paths inside are already relative to
 * the site root.
 *
 * The toolchain — scan.mjs, pack.mjs, overrides.json, extras.json, deploy.sh,
 * README.md — is deliberately left out. It is not part of the site.
 *
 * No dependencies: this writes the ZIP container by hand over zlib.
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, 'dist');
const OUT = resolve(OUT_DIR, 'radrebeldeveloper.com.zip');

/* What the server actually serves. Everything else stays on this machine. */
const FILES = ['index.html', 'projects.json'];
const DIRS = ['assets', 'icons'];

/* ------------------------------------------------------------------- crc32 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* --------------------------------------------------------------- zip pieces */

function dosStamp(date) {
  const y = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function entry(name, body, mtime) {
  const data = deflateRawSync(body, { level: 9 });
  const { time, date } = dosStamp(mtime);
  const nameBuf = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034B50, 0);   /* local file header */
  local.writeUInt16LE(20, 4);           /* version needed */
  local.writeUInt16LE(0, 6);            /* flags */
  local.writeUInt16LE(8, 8);            /* method: deflate */
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc32(body), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);           /* extra length */

  return { name: nameBuf, body, data, time, date, crc: crc32(body),
           local: Buffer.concat([local, nameBuf, data]) };
}

function central(e, offset) {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014B50, 0);    /* central directory header */
  head.writeUInt16LE(20, 4);            /* version made by */
  head.writeUInt16LE(20, 6);            /* version needed */
  head.writeUInt16LE(0, 8);
  head.writeUInt16LE(8, 10);
  head.writeUInt16LE(e.time, 12);
  head.writeUInt16LE(e.date, 14);
  head.writeUInt32LE(e.crc, 16);
  head.writeUInt32LE(e.data.length, 20);
  head.writeUInt32LE(e.body.length, 24);
  head.writeUInt16LE(e.name.length, 28);
  head.writeUInt16LE(0, 30);            /* extra */
  head.writeUInt16LE(0, 32);            /* comment */
  head.writeUInt16LE(0, 34);            /* disk */
  head.writeUInt16LE(0, 36);            /* internal attrs */
  head.writeUInt32LE(0, 38);            /* external attrs */
  head.writeUInt32LE(offset, 42);
  return Buffer.concat([head, e.name]);
}

/* --------------------------------------------------------------------- main */

async function collect() {
  const out = [];
  for (const f of FILES) out.push(f);
  for (const d of DIRS) {
    let names = [];
    try { names = await readdir(resolve(HERE, d)); } catch { continue; }
    for (const name of names.sort()) out.push(posix.join(d, name));
  }
  return out;
}

export default async function pack() {
  const paths = await collect();
  const entries = [];
  let raw = 0;

  for (const rel of paths) {
    const abs = resolve(HERE, rel);
    const info = await stat(abs);
    if (!info.isFile()) continue;
    const body = await readFile(abs);
    raw += body.length;
    entries.push(entry(rel, body, info.mtime));
  }

  const chunks = [];
  const dir = [];
  let offset = 0;
  for (const e of entries) {
    dir.push(central(e, offset));
    chunks.push(e.local);
    offset += e.local.length;
  }

  const cd = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);     /* end of central directory */
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const zip = Buffer.concat([...chunks, cd, end]);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT, zip);

  return { files: entries.length, raw, packed: zip.length, out: OUT };
}

/* run directly, not when scan.mjs imports it */
if (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await pack();
  const kb = n => (n / 1024).toFixed(0) + ' KB';
  console.log(`packed ${r.files} files — ${kb(r.raw)} → ${kb(r.packed)}`);
  console.log(`  ${r.out}`);
}
