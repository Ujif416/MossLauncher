'use strict';

/**
 * java.js — find usable java binaries and (optionally) download a managed
 * Temurin runtime from Adoptium.
 *
 * Detection order:
 *   1. User-provided path in settings
 *   2. Managed runtimes in <userData>/runtimes/
 *   3. JAVA_HOME
 *   4. `java` on PATH
 *   5. Common install locations on Windows
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { PATHS, API } = require('../shared/constants');
const { fetchJson, downloadFile } = require('./net');
const { ensureDir } = require('./storage');
const AdmZip = require('adm-zip');

function execJava(javaBin, args) {
  return new Promise((resolve) => {
    execFile(javaBin, args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: err.message });
      // `java -version` prints to stderr.
      resolve({ ok: true, output: (stderr || '') + (stdout || '') });
    });
  });
}

function parseMajorVersion(output) {
  // matches e.g. openjdk version "17.0.9"  /  java version "1.8.0_292"
  const m = output.match(/(?:openjdk|java) version "(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  if (m[1] === '1' && m[2]) return parseInt(m[2], 10); // Java 8 style "1.8"
  return parseInt(m[1], 10);
}

async function checkJava(javaBin) {
  if (!javaBin || !fs.existsSync(javaBin)) return { path: javaBin, ok: false, reason: 'not-found' };
  const r = await execJava(javaBin, ['-version']);
  if (!r.ok) return { path: javaBin, ok: false, reason: r.error };
  const major = parseMajorVersion(r.output);
  return { path: javaBin, ok: true, major, raw: r.output.split('\n')[0] };
}

function candidatePaths() {
  const list = [];
  const env = process.env;
  if (env.JAVA_HOME) list.push(path.join(env.JAVA_HOME, 'bin', 'javaw.exe'), path.join(env.JAVA_HOME, 'bin', 'java.exe'));
  const roots = [
    env['ProgramFiles'] && path.join(env['ProgramFiles'], 'Java'),
    env['ProgramFiles'] && path.join(env['ProgramFiles'], 'Eclipse Adoptium'),
    env['ProgramFiles'] && path.join(env['ProgramFiles'], 'Microsoft'),
    env['ProgramFiles'] && path.join(env['ProgramFiles'], 'Zulu'),
    env['ProgramFiles'] && path.join(env['ProgramFiles'], 'Amazon Corretto'),
    env['ProgramFiles'] && path.join(env['ProgramFiles'], 'BellSoft'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Java'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'),
  ].filter(Boolean);
  for (const root of roots) {
    try {
      for (const dir of fs.readdirSync(root)) {
        list.push(path.join(root, dir, 'bin', 'javaw.exe'), path.join(root, dir, 'bin', 'java.exe'));
      }
    } catch {}
  }
  // Managed runtimes
  try {
    for (const dir of fs.readdirSync(PATHS.runtimesDir)) {
      list.push(path.join(PATHS.runtimesDir, dir, 'bin', 'javaw.exe'), path.join(PATHS.runtimesDir, dir, 'bin', 'java.exe'));
    }
  } catch {}
  list.push('javaw.exe', 'java.exe');
  return list;
}

/**
 * Find the best installed Java for a given required major version.
 * Prefers javaw.exe (no console window) and exact major match.
 */
async function detectJava(preferredMajor, userPath = '') {
  const candidates = [];
  if (userPath) candidates.push(userPath);
  candidates.push(...candidatePaths());

  const results = [];
  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    const info = await checkJava(c);
    if (info.ok) results.push(info);
  }
  if (!results.length) return { found: null, all: [] };
  results.sort((a, b) => {
    if (preferredMajor) {
      const da = Math.abs((a.major || 0) - preferredMajor);
      const db = Math.abs((b.major || 0) - preferredMajor);
      if (da !== db) return da - db;
    }
    const aw = a.path.toLowerCase().includes('javaw') ? 0 : 1;
    const bw = b.path.toLowerCase().includes('javaw') ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return (b.major || 0) - (a.major || 0);
  });
  return { found: results.find((result) => !preferredMajor || result.major === preferredMajor) || null, all: results };
}

/**
 * Download + install a Temurin JRE from Adoptium for a given feature version
 * (8, 17, 21...). Installs into <userData>/runtimes/jre-<ver>.
 */
async function installJava(majorVersion, onProgress) {
  ensureDir(PATHS.runtimesDir);
  const meta = await fetchJson(
    `${API.adoptium}/assets/latest/${majorVersion}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`
  );
  if (!Array.isArray(meta) || !meta.length) throw new Error('No JRE build found for Java ' + majorVersion);
  const binary = meta[0].binary;
  const link = binary.package.link;
  const size = binary.package.size;
  const zipPath = path.join(PATHS.cacheDir, `jre-${majorVersion}.zip`);
  await downloadFile(link, zipPath, { size, sha256: binary.package.checksum || null });
  if (onProgress) onProgress({ stage: 'extract' });
  const destDir = path.join(PATHS.runtimesDir, `jre-${majorVersion}`);
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  ensureDir(destDir);
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, true);
  // Adoptium zips contain a top-level folder — flatten it
  const entries = fs.readdirSync(destDir);
  if (entries.length === 1 && fs.statSync(path.join(destDir, entries[0])).isDirectory()) {
    const inner = path.join(destDir, entries[0]);
    for (const f of fs.readdirSync(inner)) fs.renameSync(path.join(inner, f), path.join(destDir, f));
    fs.rmdirSync(inner);
  }
  try { fs.unlinkSync(zipPath); } catch {}
  const javaw = path.join(destDir, 'bin', 'javaw.exe');
  return { path: fs.existsSync(javaw) ? javaw : path.join(destDir, 'bin', 'java.exe'), major: majorVersion };
}

/** Which Java major a Minecraft version needs (covers 1.x and 26.x+ releases). */
function requiredJavaForMc(mcVersion) {
  const m = String(mcVersion || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return 17;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  const patch = parseInt(m[3] || '0', 10);
  if (major >= 26) return 25;
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor >= 17) return 16;
  return 8;
}

module.exports = { detectJava, checkJava, installJava, requiredJavaForMc };
