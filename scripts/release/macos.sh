#!/usr/bin/env bash
# Build, sign, notarize and package Eshlik for macOS.
#
#   ELCHI_SIGNING_IDENTITY="Developer ID Application: <Team name> (<TEAMID>)" \
#   ELCHI_NOTARY_PROFILE=elchi-notary \
#   scripts/release/macos.sh
#
#   ELCHI_CLOUD_SIGN_TEAM=GZAVWWK723 scripts/release/macos.sh    # no certificate here
#
# Needs, on this Mac:
# - the Developer ID Application certificate in the login keychain, or, with
#   ELCHI_CLOUD_SIGN_TEAM, an Apple ID signed in to Xcode (Settings > Accounts)
#   whose role on that team includes "Cloud Managed Developer ID": Xcode then
#   signs with the team's Developer ID key, which stays with Apple. Only the
#   Account Holder can create a Developer ID certificate to keep in a keychain;
#   an Admin can be given cloud signing. App Store Connect API keys cannot use
#   it ("Cloud signing permission error"). The DMG is then not signed itself:
#   the app inside it is signed, notarized and stapled, and so is the DMG's
#   notarization ticket;
# - a notarytool Keychain profile, created once with
#     xcrun notarytool store-credentials elchi-notary --key <AuthKey.p8> --key-id <ID> --issuer <ISSUER>
#   (or --apple-id/--team-id with an app-specific password);
# - Eshlik's updater key at ~/.tauri/elchi-updater.key, its password in the
#   Keychain item "elchi-updater-key-password".
#
# Order matters: the app is notarized and stapled first, and only then packed
# into the updater bundle and the DMG, so both carry the same notarized app.
#
# Output: release-out/<version>/ with Eshlik_<v>_aarch64.dmg,
# Eshlik_<v>_aarch64.app.tar.gz and its .sig.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

CLOUD_TEAM="${ELCHI_CLOUD_SIGN_TEAM:-}"
IDENTITY="${ELCHI_SIGNING_IDENTITY:-}"
[ -n "$IDENTITY$CLOUD_TEAM" ] \
  || { echo "error: set ELCHI_SIGNING_IDENTITY (a Developer ID Application identity) or ELCHI_CLOUD_SIGN_TEAM" >&2; exit 1; }
PROFILE="${ELCHI_NOTARY_PROFILE:-elchi-notary}"
# Apple silicon only for now: ort-sys has no prebuilt ONNX Runtime for Intel
# Macs, so an Intel (or universal) build needs ORT_LIB_LOCATION pointing at a
# downloaded runtime and the dylib bundled, as .github/workflows/build.yml does.
TARGET="${ELCHI_MAC_TARGET:-aarch64-apple-darwin}"
ARCH_LABEL="${TARGET%%-apple-darwin}"
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
# Not under dist/: that is Vite's output folder, emptied by every app build.
OUT="$ROOT/release-out/$VERSION"

fail() { echo "error: $*" >&2; exit 1; }

if [ -z "$CLOUD_TEAM" ]; then
  security find-identity -v -p codesigning | grep -qF "\"$IDENTITY\"" \
    || fail "signing identity not found in the keychain: $IDENTITY"
fi
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 \
  || fail "notarytool Keychain profile '$PROFILE' is missing or invalid"
[ -f "$HOME/.tauri/elchi-updater.key" ] || fail "updater key missing: ~/.tauri/elchi-updater.key"

TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/elchi-updater.key")"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s elchi-updater-key-password -w)"
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

echo "==> Building Eshlik $VERSION for $TARGET, signed as: ${IDENTITY:-Developer ID of team $CLOUD_TEAM, in the cloud}"
rustup target add aarch64-apple-darwin >/dev/null
# Tauri signs the app (hardened runtime, entitlements from tauri.conf.json),
# ad hoc when it is to be cloud signed. Its own notarization is skipped (no
# APPLE_* credentials in the environment); notarytool below does it with the
# Keychain profile.
APPLE_SIGNING_IDENTITY="${IDENTITY:--}" CI=true \
  bun run tauri build --target "$TARGET" --bundles app \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'

BUNDLE="$ROOT/src-tauri/target/$TARGET/release/bundle/macos"
APP="$BUNDLE/Eshlik.app"
[ -d "$APP" ] || fail "no app bundle at $APP"

if [ -n "$CLOUD_TEAM" ]; then
  echo "==> Cloud signing with team $CLOUD_TEAM's Developer ID (through Xcode)"
  # Xcode only exports archives, so the app goes into one; it re-signs with
  # the entitlements the app carries, so it is signed ad hoc with them first.
  WORK="$(mktemp -d)"
  ARCHIVE="$WORK/Eshlik.xcarchive"
  mkdir -p "$ARCHIVE/Products/Applications"
  ditto "$APP" "$ARCHIVE/Products/Applications/Eshlik.app"
  codesign --force --deep --options runtime --entitlements "$ROOT/src-tauri/Entitlements.plist" \
    --sign - "$ARCHIVE/Products/Applications/Eshlik.app"
  BUNDLE_ID="$(defaults read "$APP/Contents/Info.plist" CFBundleIdentifier)"
  BUILD="$(defaults read "$APP/Contents/Info.plist" CFBundleVersion)"
  cat > "$ARCHIVE/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>ApplicationProperties</key><dict>
    <key>ApplicationPath</key><string>Applications/Eshlik.app</string>
    <key>Architectures</key><array><string>arm64</string></array>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundleVersion</key><string>$BUILD</string>
    <key>SigningIdentity</key><string>-</string>
    <key>Team</key><string>$CLOUD_TEAM</string>
  </dict>
  <key>ArchiveVersion</key><integer>2</integer>
  <key>CreationDate</key><date>$(date -u +%Y-%m-%dT%H:%M:%SZ)</date>
  <key>Name</key><string>Eshlik</string>
  <key>SchemeName</key><string>Eshlik</string>
</dict></plist>
PLIST
  cat > "$WORK/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>developer-id</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$CLOUD_TEAM</string>
  <key>destination</key><string>export</string>
</dict></plist>
PLIST
  xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$WORK/export" \
    -exportOptionsPlist "$WORK/ExportOptions.plist" -allowProvisioningUpdates >/dev/null
  rm -rf "$APP" && ditto "$WORK/export/Eshlik.app" "$APP"
  rm -rf "$WORK"
  SIGNED_BY="$(codesign -dv --verbose=2 "$APP" 2>&1)"
  grep -q "^Authority=Developer ID Application: .*($CLOUD_TEAM)$" <<<"$SIGNED_BY" \
    || fail "the exported app is not signed with team $CLOUD_TEAM's Developer ID"
fi
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> Notarizing the app"
rm -rf "$OUT" && mkdir -p "$OUT"
ZIP="$OUT/Eshlik-notarize.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
rm -f "$ZIP"
xcrun stapler staple "$APP"
spctl --assess --type execute --verbose "$APP"

echo "==> Updater bundle"
TARBALL="$OUT/Eshlik_${VERSION}_${ARCH_LABEL}.app.tar.gz"
# Without macOS metadata: bsdtar otherwise stores each file's extended
# attributes (com.apple.provenance, quarantine) as AppleDouble "._<name>"
# entries. The updater (tauri-plugin-updater) unpacks every entry with the
# top folder stripped, so "._Eshlik.app" lands on the extract folder itself and
# fails with "Operation not permitted": the update downloads, then never
# installs. The check reads the entries with Python's tarfile, as bsdtar's own
# listing folds the "._" entries back into attributes and hides them.
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -C "$BUNDLE" -czf "$TARBALL" Eshlik.app
python3 -I -c 'import sys, tarfile; sys.exit(any(n.rsplit("/", 1)[-1].startswith("._") for n in tarfile.open(sys.argv[1]).getnames()))' "$TARBALL" \
  || fail "updater bundle still carries AppleDouble ._ entries"
bunx tauri signer sign "$TARBALL" >/dev/null
[ -f "$TARBALL.sig" ] || fail "updater signature was not written"

echo "==> DMG"
# The window it opens: the branded drag-to-Applications background
# (scripts/brand/dmg_background.html), laid out by dmgbuild without driving Finder.
DMG="$OUT/Eshlik_${VERSION}_${ARCH_LABEL}.dmg"
uvx -q dmgbuild -s "$ROOT/scripts/release/dmg_settings.py" -D app="$APP" \
  -D background="$ROOT/scripts/release/dmg/background.tiff" "Eshlik" "$DMG"
if [ -n "$IDENTITY" ]; then
  codesign --sign "$IDENTITY" --timestamp "$DMG"
fi
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
if [ -n "$IDENTITY" ]; then
  spctl --assess --type open --context context:primary-signature --verbose "$DMG"
fi

(cd "$OUT" && shasum -a 256 ./*.dmg ./*.tar.gz > SHA256SUMS)
echo "==> Done: $OUT"
ls -la "$OUT"
