#!/usr/bin/env python3
"""Put an Eshlik release on speech.patientdesk.ai.

    scripts/release/publish.py --site ~/dev/stt-website-elchi --windows-run <GitHub run id> \
        [--linux-run <GitHub run id>] [--notes "…"] [--windows-only]

Takes the macOS files made by scripts/release/macos.sh (release-out/<version>/),
the Windows installer from the "Eshlik Windows build" workflow run and, with
--linux-run, the AppImage and .deb from the "Eshlik Linux build" run (their
artifacts, downloaded with `gh`), then, in the website checkout:

- copies them to public/downloads/elchi/<version>/ with SHA256SUMS, except files of
  LARGE_BYTES or more (the AppImage, ~130 MB: GitHub refuses files over 100 MB in a
  repository), which go to the GitHub release v<version> of this repository instead
  and are listed with their URL;
- writes lib/elchi/release.json (what the /elchi page offers);
- writes public/downloads/elchi/latest.json (the updater manifest).

It does not commit or push: review the site diff, then commit and push the
site's main to deploy.
"""

import argparse
import datetime as dt
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SITE_URL = "https://speech.patientdesk.ai"
REPO = "Patientdesk-AI/elchi"
LARGE_BYTES = 90 * 1024 * 1024


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def one(paths: list[Path], what: str) -> Path:
    if len(paths) != 1:
        sys.exit(f"expected exactly one {what}, found {[p.name for p in paths]}")
    return paths[0]


def check_updater_tarball(path: Path) -> None:
    """Refuse a macOS updater bundle the updater cannot install.

    tauri-plugin-updater unpacks every entry with its first path component
    stripped, so an AppleDouble "._Eshlik.app" entry (bsdtar's way of storing
    extended attributes) is written over the extract folder itself and the
    install fails after the download. scripts/release/macos.sh packs without
    them; this catches a bundle made any other way.
    """
    with tarfile.open(path) as tar:
        names = tar.getnames()
    apple_double = [n for n in names if n.rsplit("/", 1)[-1].startswith("._")]
    if apple_double:
        sys.exit(f"{path.name} has AppleDouble entries the updater cannot install "
                 f"(e.g. {apple_double[0]}): repack it with "
                 "COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs")
    if not all(n == "Eshlik.app" or n.startswith("Eshlik.app/") for n in names):
        sys.exit(f"{path.name} must hold only Eshlik.app/, found {names[:3]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, type=Path, help="website checkout (stt-website)")
    ap.add_argument("--windows-run", required=True, help="run id of the 'Eshlik Windows build' workflow")
    ap.add_argument("--notes", default="", help="release notes shown by the updater")
    ap.add_argument("--windows-only", action="store_true",
                    help="publish the Windows installer alone (macOS keeps its 'coming soon')")
    ap.add_argument("--linux-run", help="run id of the 'Eshlik Linux build' workflow (AppImage and .deb)")
    ap.add_argument("--commit", help="the commit the release was built from (default: HEAD); tags the GitHub release")
    args = ap.parse_args()

    version = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["version"]
    commit_full = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", args.commit or "HEAD"], text=True).strip()
    commit = commit_full[:7]
    mac_dir = ROOT / "release-out" / version
    mac = None
    if not args.windows_only:
        if not mac_dir.is_dir():
            sys.exit(f"{mac_dir} missing: run scripts/release/macos.sh first (or pass --windows-only)")
        dmg = one(sorted(mac_dir.glob("*.dmg")), "macOS DMG")
        mac_tar = one(sorted(mac_dir.glob("*.app.tar.gz")), "macOS updater bundle")
        mac_sig = Path(f"{mac_tar}.sig")
        if not mac_sig.exists():
            sys.exit(f"{mac_sig.name} missing")
        check_updater_tarball(mac_tar)
        mac = (dmg, mac_tar, mac_sig)

    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["gh", "run", "download", args.windows_run, "-R", REPO, "-D", tmp], check=True)
        exes = [p for p in Path(tmp).rglob("*-setup.exe")]
        exe = one(exes, "Windows installer")
        if f"_{version}_" not in exe.name:
            sys.exit(f"Windows installer {exe.name} is not version {version}")
        exe_sig = Path(f"{exe}.sig")
        if not exe_sig.exists():
            sys.exit(f"{exe_sig.name} missing: the Windows build was not signed for the updater")

        linux = None
        if args.linux_run:
            ltmp = Path(tmp) / "linux"
            subprocess.run(["gh", "run", "download", args.linux_run, "-R", REPO, "-D", str(ltmp)], check=True)
            appimage = one(list(ltmp.rglob("*.AppImage")), "AppImage")
            deb = one(list(ltmp.rglob("*.deb")), "Linux .deb")
            for f in (appimage, deb):
                if f"_{version}_" not in f.name:
                    sys.exit(f"{f.name} is not version {version}")
            appimage_sig = Path(f"{appimage}.sig")
            if not appimage_sig.exists():
                sys.exit(f"{appimage_sig.name} missing: the AppImage was not signed for the updater")
            linux = (appimage, appimage_sig, deb)

        dest = args.site / "public/downloads/elchi" / version
        dest.mkdir(parents=True, exist_ok=True)
        sources = {}            # published name -> where its bytes are, for checksums
        remote = {}             # published name -> URL, for files too large for the site
        for src in (*(mac or ()), exe, exe_sig, *(linux or ())):
            if src.stat().st_size >= LARGE_BYTES:
                kept = Path(tempfile.mkdtemp(prefix="elchi-publish-")) / src.name  # outlives the download dir
                shutil.copy2(src, kept)
                sources[src.name] = kept
                remote[src.name] = f"https://github.com/{REPO}/releases/download/v{version}/{src.name}"
            else:
                shutil.copy2(src, dest / src.name)
                sources[src.name] = dest / src.name

    entries = [(exe.name, "windows", "x86_64", "installer"), (f"{exe.name}.sig", "windows", "x86_64", "signature")]
    if linux:
        # The AppImage first: it is the Linux download the page offers, and the one the
        # updater replaces in place; the .deb is offered beside it for Debian and Ubuntu.
        appimage, appimage_sig, deb = linux
        entries += [(appimage.name, "linux", "x86_64", "installer"), (appimage_sig.name, "linux", "x86_64", "signature"),
                    (deb.name, "linux", "x86_64", "installer")]
    if mac:
        dmg, mac_tar, mac_sig = mac
        mac_arch = "universal" if "universal" in dmg.name else ("aarch64" if "aarch64" in dmg.name else "x86_64")
        entries = [
            (dmg.name, "macos", mac_arch, "installer"),
            (mac_tar.name, "macos", mac_arch, "updater"),
            (mac_sig.name, "macos", mac_arch, "signature"),
        ] + entries
    remote_sizes = {n: sources[n].stat().st_size for n in remote}
    remote_sums = {n: sha256(sources[n]) for n in remote}
    if remote:
        tag = f"v{version}"
        if subprocess.run(["gh", "release", "view", tag, "-R", REPO], capture_output=True).returncode != 0:
            subprocess.run(["gh", "release", "create", tag, "-R", REPO, "--target", commit_full,
                            "--title", f"Eshlik {version}", "--notes", args.notes or f"Eshlik {version}"], check=True)
        subprocess.run(["gh", "release", "upload", tag, "-R", REPO, "--clobber",
                        *[str(sources[n]) for n in remote]], check=True)
        for n in remote:
            shutil.rmtree(sources[n].parent)

    files = []
    for name, platform, arch, kind in entries:
        p = sources[name]
        entry = {"platform": platform, "arch": arch, "kind": kind, "name": name,
                 "bytes": p.stat().st_size if p.exists() else remote_sizes[name],
                 "sha256": sha256(p) if p.exists() else remote_sums[name]}
        if name in remote:
            entry["url"] = remote[name]
        files.append(entry)
    (dest / "SHA256SUMS").write_text("".join(f"{f['sha256']}  {f['name']}\n" for f in files))

    today = dt.date.today().isoformat()
    release = {"app": "Elchi", "version": version, "date": today, "commit": commit, "files": files}
    (args.site / "lib/elchi/release.json").write_text(json.dumps(release, indent=1) + "\n")

    base = f"{SITE_URL}/downloads/elchi/{version}"
    platforms = {}
    if mac:
        mac_entry = {"signature": mac_sig.read_text().strip(), "url": f"{base}/{mac_tar.name}"}
        for t in (["darwin-aarch64", "darwin-x86_64"] if mac_arch == "universal" else [f"darwin-{mac_arch}"]):
            platforms[t] = mac_entry
    manifest = {
        "version": version,
        "notes": args.notes,
        "pub_date": dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "platforms": {
            **platforms,
            "windows-x86_64": {"signature": (dest / f"{exe.name}.sig").read_text().strip(),
                               "url": f"{base}/{exe.name}"},
            **({"linux-x86_64": {"signature": (dest / f"{linux[0].name}.sig").read_text().strip(),
                                 "url": remote.get(linux[0].name, f"{base}/{linux[0].name}")}} if linux else {}),
        },
    }
    (args.site / "public/downloads/elchi/latest.json").write_text(json.dumps(manifest, indent=1) + "\n")

    print(f"Eshlik {version} staged in {args.site}:")
    for f in files:
        print(f"  {f['name']}  {f['bytes'] / 1e6:.1f} MB")
    print("Review `git -C <site> status`, then commit and push the site's main to deploy.")


if __name__ == "__main__":
    main()
