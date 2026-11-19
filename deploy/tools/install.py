#!/usr/bin/env python3
"""Install the Pojun host-tool inventory on a fresh GitHub Actions runner.

Single source of truth: deploy/tools/tool-catalog.json, which is extracted from
Pojun's hosttools.catalog (the same catalog that drives /api/hostenv/status and
the one-click installer). This reproduces the official install recipes so that
hostenv's `exec.LookPath` / Detect checks turn green.

Idempotent: skips tools already available. Per-tool failures are recorded but
do not abort the whole run; the exit code is non-zero only if < MIN_OK tools
became available (so a few flaky GitHub downloads don't fail the deploy).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = os.path.dirname(os.path.abspath(__file__))
CATALOG = os.path.join(BASE, 'tool-catalog.json')
BIN_DIR = '/usr/local/bin'
MIN_RATIO = float(os.environ.get('TOOLS_MIN_RATIO', '0.85'))
PARALLEL = int(os.environ.get('TOOLS_PARALLEL', '6'))

ARCH = os.uname().machine  # x86_64 | aarch64
ARCH_MAP = {
    'arch':  'amd64' if ARCH == 'x86_64' else 'arm64',
    'arch2': 'x86_64' if ARCH == 'x86_64' else 'aarch64',
    'arch3': 'x86'    if ARCH == 'x86_64' else 'arm',
    'arch4': 'x64'    if ARCH == 'x86_64' else 'arm64',
    'arch5': '64bit'  if ARCH == 'x86_64' else 'ARM64',
}

results = {}  # id -> (ok:bool, msg:str)


def log(*a):
    print('[tools]', *a, flush=True)


def run(cmd, timeout=600, shell=False):
    return subprocess.run(cmd, shell=shell, timeout=timeout,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True)


def exists_path(p):
    return os.path.exists(p)


def available(t):
    """Reproduce hosttools.detectOne / AvailableInPath."""
    tid = t['id']
    det = t.get('Detect', '')
    if det:
        if det.startswith('any:'):
            return any(available({**t, 'Detect': d}) for d in det[4:].split(','))
        if det.startswith('path:'):
            return exists_path(det[5:])
        if det.startswith('dir:'):
            return os.path.isdir(det[4:])
        if det.startswith('python:'):
            mod = det[7:]
            return run([sys.executable, '-c', f'import {mod}']).returncode == 0
    return shutil.which(tid) is not None


def detect_ok(t):
    ok = available(t)
    results[t['id']] = (ok, 'already available' if ok else 'missing')
    return ok


# ---------------- apt ----------------
def install_apt(tools):
    pkgs = sorted({p for t in tools for p in t.get('apt', [])})
    if not pkgs:
        return
    log(f'apt: installing {len(pkgs)} packages')
    env = os.environ.copy()
    env['DEBIAN_FRONTEND'] = 'noninteractive'
    r = subprocess.run(['sudo', 'apt-get', 'update', '-qq'], env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=300)
    if r.returncode != 0:
        log('apt update failed:', r.stdout[-500:])
    r = subprocess.run(['sudo', 'apt-get', 'install', '-y', '-qq', '--no-install-recommends', *pkgs],
                       env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=1800)
    log('apt install rc=', r.returncode)
    if r.returncode != 0:
        log('apt tail:', r.stdout[-1500:])
    for t in tools:
        ok, _ = results.get(t['id'], (False, ''))
        if not ok:
            now = available(t)
            results[t['id']] = (now, 'apt installed' if now else 'apt install failed')


# ---------------- pip ----------------
def install_pip(tools):
    cli, libs = [], []
    for t in tools:
        (libs if t.get('lib') else cli).extend(t.get('pip', []))
    for label, pkgs, force_py in [('pip CLI', sorted(set(cli)), False),
                                  ('pip libs', sorted(set(libs)), True)]:
        if not pkgs:
            continue
        log(f'{label}: installing {len(pkgs)} packages')
        if not force_py and shutil.which('pipx'):
            cmd = ['sudo', 'pipx', 'install', '--global', '--pip-args=--no-cache-dir', *pkgs]
        else:
            cmd = [sys.executable, '-m', 'pip', 'install', '--break-system-packages',
                   '--no-cache-dir', *pkgs]
        r = run(cmd, timeout=1800)
        log(f'{label} rc=', r.returncode)
        if r.returncode != 0:
            log(f'{label} tail:', r.stdout[-1500:])
    for t in tools:
        ok, _ = results.get(t['id'], (False, ''))
        if not ok:
            now = available(t)
            results[t['id']] = (now, 'pip installed' if now else 'pip install failed')


# ---------------- github ----------------
def latest_tag(repo):
    req = urllib.request.Request(f'https://api.github.com/repos/{repo}/releases/latest',
                                 headers={'User-Agent': 'pojun-tools-installer',
                                          'Accept': 'application/vnd.github+json'})
    token = os.environ.get('GITHUB_TOKEN', '')
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)['tag_name']


def expand(tmpl, tag):
    ver = tag[1:] if tag.startswith('v') else tag
    out = tmpl
    out = out.replace('{verv}', tag).replace('{ver}', ver)
    for k, v in ARCH_MAP.items():
        out = out.replace('{' + k + '}', v)
    return out


def unpack(blob_path, dest_dir):
    """Return dir containing extracted files."""
    os.makedirs(dest_dir, exist_ok=True)
    if zipfile.is_zipfile(blob_path):
        with zipfile.ZipFile(blob_path) as z:
            z.extractall(dest_dir)
    elif blob_path.endswith(('.tar.gz', '.tgz', '.tar')):
        with tarfile.open(blob_path) as tf:
            tf.extractall(dest_dir)
    elif blob_path.endswith('.gz'):
        # single-file gzip (chisel): decompress to dest_dir/<name w/o .gz>
        import gzip
        name = os.path.basename(blob_path)[:-3]
        with gzip.open(blob_path, 'rb') as f, open(os.path.join(dest_dir, name), 'wb') as o:
            shutil.copyfileobj(f, o)
    else:
        shutil.copy2(blob_path, dest_dir)
    return dest_dir


def find_bin(root, wanted):
    for dp, _, fs in os.walk(root):
        for f in fs:
            if f == wanted:
                p = os.path.join(dp, f)
                if os.access(p, os.X_OK) or wanted.endswith('.jar'):
                    return p
    # fallback: exact name regardless of exec bit
    for dp, _, fs in os.walk(root):
        if wanted in fs:
            return os.path.join(dp, wanted)
    return None


def install_github(t):
    tid = t['id']
    repo, tmpls = t['repo'], t['tmpl']
    tag = latest_tag(repo)
    for tmpl in tmpls:
        asset = expand(tmpl, tag)
        url = f'https://github.com/{repo}/releases/download/{tag}/{asset}'
        try:
            with tempfile.TemporaryDirectory() as td:
                blob = os.path.join(td, asset)
                req = urllib.request.Request(url, headers={'User-Agent': 'pojun-tools-installer'})
                token = os.environ.get('GITHUB_TOKEN', '')
                if token:
                    req.add_header('Authorization', f'Bearer {token}')
                with urllib.request.urlopen(req, timeout=180) as r, open(blob, 'wb') as f:
                    shutil.copyfileobj(r, f)
                ex = os.path.join(td, 'x')
                unpack(blob, ex)
                wanted = t.get('BinInZip') or tid
                src = find_bin(ex, wanted)
                if not src:
                    # for raw single-file tools the asset name itself may differ
                    cand = [os.path.join(ex, f) for f in os.listdir(ex)]
                    src = cand[0] if len(cand) == 1 else None
                if not src:
                    continue
                dest = t.get('DestPath') or os.path.join(BIN_DIR, tid)
                if dest.startswith('/opt/') and not os.path.isdir(os.path.dirname(dest)):
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.copy2(src, dest)
                os.chmod(dest, 0o755)
                if available(t) or os.path.exists(dest):
                    return True, f'{tag}/{asset}'
        except Exception as e:
            last = str(e)[:120]
            continue
    return False, f'no asset matched tag={tag} (last={last if "last" in dir() else "?"})'


# ---------------- script ----------------
def install_script(t):
    script = t.get('Script', '')
    if not script:
        return False, 'no script'
    r = run(['sudo', 'bash', '-c', script], timeout=1800)
    now = available(t)
    return now, ('script ok' if now else f'script rc={r.returncode}: {r.stdout[-300:]}')


def main():
    tools = json.load(open(CATALOG, encoding='utf-8'))
    log(f'catalog: {len(tools)} tools, arch={ARCH}')

    # 1) initial detection
    todo = {'apt': [], 'pip': [], 'github': [], 'script': []}
    for t in tools:
        if detect_ok(t):
            continue
        todo.setdefault(t['kind'], []).append(t)
    log('initial: available=%d, todo=%s' %
        (sum(1 for v in results.values() if v[0]), {k: len(v) for k, v in todo.items()}))

    # 2) batch install apt + pip
    install_apt(todo['apt'])
    install_pip(todo['pip'])

    # 3) github (parallel) + script (sequential, may share /opt)
    with ThreadPoolExecutor(max_workers=PARALLEL) as ex:
        futs = {ex.submit(install_github, t): t for t in todo['github']}
        for f in as_completed(futs):
            t = futs[f]
            try:
                ok, msg = f.result()
            except Exception as e:
                ok, msg = False, str(e)[:120]
            results[t['id']] = (ok, msg)
            log(f"github {t['id']}: {'OK' if ok else 'FAIL'} {msg}")
    for t in todo['script']:
        ok, msg = install_script(t)
        results[t['id']] = (ok, msg)
        log(f"script {t['id']}: {'OK' if ok else 'FAIL'} {msg}")

    # 4) final re-check via hostenv's exact detection
    final_ok = 0
    for t in tools:
        ok = available(t)
        results[t['id']] = (ok, 'available' if ok else results[t['id']][1])
        final_ok += ok
    total = len(tools)
    log(f'FINAL: {final_ok}/{total} tools available ({final_ok/total:.0%})')
    fails = [i for i, (ok, _) in results.items() if not ok]
    if fails:
        log('missing: ' + ', '.join(fails))

    # GitHub step summary
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as f:
            f.write(f'### Host tools\n\n{final_ok}/{total} available '
                    f'({final_ok/total:.0%})\n\n')
            if fails:
                f.write('Missing: ' + ', '.join(fails) + '\n')
    return 0 if final_ok / total >= MIN_RATIO else 1


if __name__ == '__main__':
    sys.exit(main())
