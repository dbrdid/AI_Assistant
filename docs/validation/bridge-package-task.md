# 코드 작업: Stella 브리지 설치본

담당: Orca Claude. 이 지시서는 커밋하지 않는다. 스킬: `ponytail`(full), `loop`, `token-efficient-workflow`.

## 목표

메모앱과 별도로 내려받아 쓰는 브리지 설치본을 만든다.

1. **Windows 단일 실행 파일** `stella-bridge.exe`: Node.js를 설치하지 않은 PC에서도 실행된다.
2. **npm 패키지** `.tgz`: Node.js가 있는 서버에서 `npx`나 `npm i -g`로 설치한다. 레지스트리에 공개 배포하지는 않는다.

## 확인된 환경

- 이 PC의 Node는 v26.13.0이고 `node --build-sea`를 지원한다. postject 같은 추가 도구를 내려받지 않는다.
- 브리지는 `bridge/bridge.mjs`, `bridge/stella-bridge.mjs` 두 파일이고, `node:` 표준 모듈만 쓴다.

## 작업

- `bridge/package.json`: 이름 `stella-bridge`, `bin`으로 `stella-bridge` 명령, `engines.node >= 20`, `files`는 실행에 필요한 파일만. `private`은 두지 않되 `publishConfig` 등으로 실수 배포를 막을 수 있으면 막는다.
- `bridge/build.mjs`(또는 `npm run build` 스크립트):
  - SEA 설정을 만들고 `node --build-sea`로 `bridge/dist/stella-bridge.exe`를 생성한다. SEA가 ESM 진입점을 지원하지 않으면, 의존성 없이 두 파일을 하나의 스크립트로 합치는 최소 단계를 둔다.
  - `npm pack`으로 `bridge/dist/stella-bridge-<버전>.tgz`를 생성한다.
  - 산출물 SHA-256을 `bridge/dist/SHA256SUMS.txt`에 쓴다.
- `bridge/dist/`는 `.gitignore`에 추가한다. 실행 파일은 저장소에 커밋하지 않는다.
- 실행 파일에서 `--version`이 동작하게 한다. 버전은 `package.json`과 맞춘다.
- 실행 파일일 때 `enable-cli`가 `claude`·`codex`를 찾는 경로 처리가 그대로 동작하는지 확인한다.

## 확인

- `stella-bridge.exe --version`, `init`, `list`, `serve`가 Node 없이 동작하는지 PATH에서 node를 뺀 셸로 확인한다. 설정은 임시 위치(`STELLA_BRIDGE_CONFIG`)를 쓰고 끝나면 지운다.
- `.tgz`를 임시 폴더에 설치해 `stella-bridge --version`과 `init`을 확인한다.
- `npm run -s test:integration`이 통과한다.
- 원장에 한 줄을 남기고, GPT에게 `bridge/README.md`에 설치본 사용법(내려받기, 실행, Windows SmartScreen 경고, Node 버전)을 넣도록 요청한다.

## 금지와 제한

- npm 레지스트리 배포, GitHub 릴리스 업로드, 외부 도구 다운로드, 커밋·푸시는 하지 않는다.
- 코드 서명은 하지 않는다. 서명하지 않은 실행 파일이라 Windows가 경고할 수 있다는 점을 결과에 남긴다.
- macOS·Linux 실행 파일은 해당 Node 바이너리가 필요하므로 만들지 않는다. 그 플랫폼은 npm 패키지로 안내한다.
