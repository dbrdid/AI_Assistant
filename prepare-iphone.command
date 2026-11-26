#!/bin/zsh
# Build the release preview for iPhone without signing it or installing it on a phone.
set -eu
set -o pipefail
cd "${0:A:h}/frontend/Frontend_UI"
export ATRIA_IOS_PREVIEW=1
export CI=1

command -v npm >/dev/null || { print -u2 'Node.js와 npm이 필요합니다.'; exit 1; }
command -v pod >/dev/null || { print -u2 'CocoaPods가 필요합니다.'; exit 1; }
xcrun --sdk iphoneos --show-sdk-path >/dev/null

npm ci --no-audit --no-fund
./node_modules/.bin/expo prebuild --platform ios --no-install
pod install --project-directory=ios
# A later build from the Xcode GUI must bundle JS with the same preview profile.
if ! grep -qxF 'export ATRIA_IOS_PREVIEW=1' ios/.xcode.env 2>/dev/null; then
  printf '\nexport ATRIA_IOS_PREVIEW=1\n' >> ios/.xcode.env
fi

derived="$PWD/ios/build/PreviewDerivedData"
xcodebuild -workspace ios/Atria.xcworkspace -scheme Atria \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=NO build

plist="$derived/Build/Products/Release-iphoneos/Atria.app/Info.plist"
expectedVersion=$(node -p "require('./app.json').expo.version")
plutil -convert json -o - "$plist" | node -e '
  const assert = require("node:assert/strict");
  const plist = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  assert.equal(plist.CFBundleIdentifier, "com.dbrdid.atria.iospreview");
  assert.equal(plist.CFBundleShortVersionString, process.argv[1]);
  assert.equal(plist.CFBundleVersion, "1");
  assert(plist.CFBundleURLTypes?.some(type => type.CFBundleURLSchemes?.includes("ai-assistant-planner")), "로그인 복귀 주소 누락");
  for (const key of ["NSMicrophoneUsageDescription", "NSCameraUsageDescription", "NSPhotoLibraryUsageDescription"]) {
    assert(typeof plist[key] === "string" && plist[key].trim(), key + " 권한 문구 누락");
  }
' "$expectedVersion"

print "Atria $expectedVersion 아이폰 서명 전 빌드와 권한 안내 문구를 확인했습니다."
print "실기기 서명에 사용할 Xcode 프로젝트: $PWD/ios/Atria.xcworkspace"
