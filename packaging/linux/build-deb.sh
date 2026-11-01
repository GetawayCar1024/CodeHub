#!/usr/bin/env bash
# Build the Ubuntu / Debian .deb of CodeHub from the folder staged by `node packaging/package.mjs linux`.
#
#   packaging/linux/build-deb.sh <dist/CodeHub-<version>-linux-x64> <version> <output.deb>
#
# Everything (including the Node.js runtime) is installed under /opt/codehub; /usr/bin/codehub starts it.
set -euo pipefail

STAGE=$1
VERSION=$2
OUT=$3
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(mktemp -d)
APP=$ROOT/opt/codehub
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$APP" "$ROOT/usr/bin" "$ROOT/lib/systemd/system" "$ROOT/usr/share/doc/codehub" "$ROOT/DEBIAN"
cp -r "$STAGE"/. "$APP/"
rm -f "$APP/codehub"
find "$APP" -type d -exec chmod 755 {} +
find "$APP" -type f -exec chmod 644 {} +
chmod 755 "$APP/bin/node"

install -m755 "$HERE/codehub" "$ROOT/usr/bin/codehub"
install -m644 "$HERE/codehub.service" "$ROOT/lib/systemd/system/codehub.service"
install -m644 "$STAGE/LICENSE" "$ROOT/usr/share/doc/codehub/copyright"
install -m755 "$HERE/postinst" "$HERE/prerm" "$HERE/postrm" "$ROOT/DEBIAN/"

cat > "$ROOT/DEBIAN/control" <<EOF
Package: codehub
Version: $VERSION
Architecture: amd64
Maintainer: heyicong <heyicong.jeremy@gmail.com>
Installed-Size: $(du -sk "$ROOT/opt" | cut -f1)
Depends: libc6 (>= 2.28), libstdc++6
Section: web
Priority: optional
Homepage: https://github.com/GetawayCar1024/CodeHub
Description: source code collection system for OI contests
 Contestants submit their source code in the browser; the administrator
 manages users, groups and contests. CodeHub can work together with
 LemonServer: submissions are uploaded and judged automatically.
EOF

dpkg-deb --root-owner-group -Zxz --build "$ROOT" "$OUT"
dpkg-deb --info "$OUT"
