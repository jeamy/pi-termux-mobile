#!/usr/bin/env python3
"""Refresh phi-spaces from source and package the mobile runtime before every Android build."""
import gzip
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(os.environ.get('PHI_SPACES_SOURCE', str(ROOT.parent / 'phi-spaces'))).resolve()
RUNTIME = ROOT / 'runtime'
ASSETS = ROOT / 'android/app/src/main/assets'
FILES = ['server.mjs', 'common.mjs', 'remote-env.mjs', 'env-server.mjs', 'pi-serverd.mjs',
         'space-keystore.mjs', 'spaces-mobile.mjs', 'remote-client.mjs', 'remote-provision.mjs', 'remote-state.mjs', 'remote-calls.mjs', 'phi-spaces.mjs', 'package.json',
         'package-lock.json', 'public', 'node_modules', 'space-examples']

source_available = (SOURCE / 'scripts/bundle-mobile.mjs').is_file()
if not source_available:
    print(f'WARNING: phi-spaces source checkout missing or incompatible: {SOURCE}; '
          'using existing mobile bundles without refreshing them. Set PHI_SPACES_SOURCE to enable refresh.',
          file=sys.stderr)
if not (RUNTIME / 'node_modules/@earendil-works/pi-durable').is_dir():
    raise SystemExit('Mobile runtime dependencies missing; install the locked runtime dependencies first')
if not (ASSETS / 'rootfs.bin').is_file():
    raise SystemExit('Termux rootfs.bin is missing; prepare the rootfs asset first')
for name in FILES:
    if name not in ('phi-spaces.mjs', 'space-examples') and not (RUNTIME / name).exists():
        raise SystemExit(f'Required runtime input missing: {name}')
# A packaged module that imports a sibling the list leaves out starts on the phone and dies there (node exits 1,
# PiService restarts it forever): refuse the build instead.
import re
for name in FILES:
    if name.endswith('.mjs') and (RUNTIME / name).is_file():
        for sibling in re.findall(r"""(?:from|import)\s*\(?\s*['"]\./([^'"/]+)['"]""", (RUNTIME / name).read_text(encoding='utf-8')):
            if sibling not in FILES:
                raise SystemExit(f'{name} imports ./{sibling}, which is not packaged: add it to FILES in scripts/prepare-runtime.py')
if source_available:
    subprocess.run(['npm', 'run', 'bundle'], cwd=SOURCE, check=True,
                   env={**os.environ, 'PHI_SPACES_MOBILE_ROOT': str(ROOT)})
if not (RUNTIME / 'phi-spaces.mjs').is_file():
    raise SystemExit('Required mobile bundle missing: phi-spaces.mjs; prepare it from a phi-spaces source checkout first')
# The phone's space server (M1, phi-spaces docs/m1-mobile.en.md): phi-space-server for aarch64-linux-android, built
# from the same checkout as phi-spaces.mjs so both speak the same wire, stripped into runtime/bin (not committed).
# PiService runs it when the payload carries it; without it the app runs as before. PHI_SPACE_SERVER_SKIP=1 leaves it
# out, PHI_SPACE_SERVER_BINARY names a binary built elsewhere.
def space_server():
    target = RUNTIME / 'bin/phi-space-server'
    if os.environ.get('PHI_SPACE_SERVER_SKIP') == '1':
        target.unlink(missing_ok=True)
        print('phi-space-server left out (PHI_SPACE_SERVER_SKIP=1)', file=sys.stderr)
        return
    ndk = sorted((ROOT / 'tools/android-sdk/ndk').glob('*/toolchains/llvm/prebuilt/linux-x86_64/bin'))
    built = os.environ.get('PHI_SPACE_SERVER_BINARY')
    if not built and source_available and ndk and (SOURCE / 'rust/Cargo.toml').is_file():
        bin_dir = ndk[-1]
        clang = str(bin_dir / 'aarch64-linux-android24-clang')
        subprocess.run(['cargo', 'build', '--release', '--locked', '--target', 'aarch64-linux-android', '-p', 'phi-space-server'],
                       cwd=SOURCE / 'rust', check=True,
                       env={**os.environ, 'CC_aarch64_linux_android': clang, 'AR_aarch64_linux_android': str(bin_dir / 'llvm-ar'),
                            'CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER': clang})
        built = str(SOURCE / 'rust/target/aarch64-linux-android/release/phi-space-server')
    if not built:
        if not target.is_file():
            print('WARNING: phi-space-server not built (no phi-spaces source, NDK or cargo); packaging without the space server',
                  file=sys.stderr)
        return
    target.parent.mkdir(exist_ok=True)
    tmp = target.with_suffix('.tmp')
    strip = ndk[-1] / 'llvm-strip' if ndk else None
    if strip and strip.is_file():
        subprocess.run([str(strip), '-o', str(tmp), built], check=True)
    else:
        tmp.write_bytes(Path(built).read_bytes())
    tmp.chmod(0o755)
    replace_if_changed(tmp, target)
    target.chmod(0o755)

if (RUNTIME / 'space-examples').is_dir():
    FILES.append('space-examples')
else:
    print('WARNING: optional space-examples missing; packaging the runtime without CLI examples', file=sys.stderr)

def entries(path):
    if path.name == '.bin':
        return
    # Retain valid links, exclude broken links without deleting developer files.
    if path.is_symlink():
        if path.exists():
            yield path
        return
    yield path
    if path.is_dir():
        for child in sorted(path.iterdir()):
            yield from entries(child)

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.digest()

def replace_if_changed(source, target):
    if target.is_file() and digest(source) == digest(target):
        source.unlink()
    else:
        source.replace(target)

space_server()
if (RUNTIME / 'bin/phi-space-server').is_file():
    FILES.append('bin')

ASSETS.mkdir(parents=True, exist_ok=True)
temporary = None
try:
    with tempfile.NamedTemporaryFile(dir=ASSETS, suffix='.tmp', delete=False) as raw:
        temporary = Path(raw.name)
        with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for name in FILES:
                    for path in entries(RUNTIME / name):
                        info = archive.gettarinfo(str(path), 'runtime/' + path.relative_to(RUNTIME).as_posix())
                        info.uid = info.gid = info.mtime = 0
                        info.uname = info.gname = ''
                        if info.isfile():
                            with path.open('rb') as stream:
                                archive.addfile(info, stream)
                        else:
                            archive.addfile(info)
    replace_if_changed(temporary, ASSETS / 'runtime.bin')
    temporary = None
    # Both payloads determine extraction; RuntimeInstaller's version still covers installer changes.
    fingerprint = hashlib.sha256(digest(ASSETS / 'rootfs.bin') + digest(ASSETS / 'runtime.bin')).hexdigest()
    with tempfile.NamedTemporaryFile(dir=ASSETS, suffix='.tmp', delete=False) as raw:
        temporary = Path(raw.name)
        raw.write((fingerprint + '\n').encode('ascii'))
    replace_if_changed(temporary, ASSETS / 'payload.sha256')
    temporary = None
    print(f'Mobile assets prepared; payload {fingerprint}')
finally:
    if temporary:
        temporary.unlink(missing_ok=True)
