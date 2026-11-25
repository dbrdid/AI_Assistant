# Atria 브리지 0.2.0

브리지는 내 컴퓨터의 로컬 모델, API 제공자, 로그인된 CLI, 플러그인을 Atria 앱의 **내 서버** 연결로 사용할 수 있게 한다. 모델이나 CLI를 실행할 컴퓨터에 앱과 별도로 설치한다.

0.1.0(Stella 브리지)에서 이름이 바뀌었다. 기존 설정 `~/.stella-bridge/config.json`은 그대로 읽으므로 앱에 넣어 둔 연결 문자열을 다시 넣지 않아도 된다. 설정을 처음 저장할 때 `~/.atria-bridge/config.json`에 쓴다.

## 설치

**Windows**에서는 릴리스의 `atria-bridge.exe`와 `SHA256SUMS.txt`를 같은 폴더에 내려받는다. PowerShell에서 아래 해시를 구해 `SHA256SUMS.txt`의 실행 파일 항목과 일치하는지 확인한다. 실행 파일에 코드 서명이 없어 SmartScreen 경고가 나타날 수 있다.

```powershell
Get-FileHash .\atria-bridge.exe -Algorithm SHA256
```

**macOS·Linux**에서는 Node.js 20 이상을 설치하고 같은 릴리스의 npm 패키지(`.tgz`)를 내려받는다.

```sh
npm i -g ./패키지파일명.tgz
```

저장소에서 바로 실행할 때는 `node bridge/atria-bridge.mjs <명령>`을 쓴다.

## 처음 연결하기

1. `atria-bridge init`을 실행하고 출력된 연결 문자열 한 줄을 복사한다.
2. `list`로 사용할 모델을 확인한 뒤 `serve`로 서버를 시작한다. 앱에서 쓰는 동안 켜 둔다.
3. 같은 네트워크의 Atria 앱에서 **AI 연결 → 내 서버 → 서버 주소**에 연결 문자열 전체를 한 번에 붙여 넣는다. 주소와 연결 키가 채워지면 **서버에서 불러오기**로 모델을 고른다.

Ollama를 쓰려면 PC에서 Ollama를 실행하고 모델을 하나 받아 둔다(예: `ollama pull gemma3:1b`). 브리지가 `http://127.0.0.1:11434`를 자동으로 찾는다.

## 명령

| 명령 | 용도 |
| --- | --- |
| `init` | 최초 설정을 만들고 연결 문자열을 출력한다. |
| `serve [--host 0.0.0.0] [--port 8787]` | 지정한 호스트와 포트에서 브리지를 실행한다. |
| `list` | 공급원별 상태와 사용 가능한 모델 ID를 표시한다. |
| `add-key <openai\|anthropic\|gemini> [모델...]` | 제공자의 API 키를 입력하고 사용할 모델을 지정한다. |
| `add-key openai-compatible <이름> <주소>` | OpenAI 호환 서버를 등록한다. 키가 필요 없으면 입력창에서 Enter를 누른다. |
| `enable-cli <claude\|codex>` | 이 PC에 설치하고 로그인한 CLI를 켠다. |
| `disable-cli [이름]` | 지정한 CLI를 끈다. 이름을 생략하면 모두 끈다. |
| `plugins` | 플러그인 폴더와 설치된 플러그인의 켜짐 상태를 표시한다. |
| `enable-plugin <id>` / `disable-plugin <id>` | 플러그인을 켜거나 끈다. 서버를 다시 시작하면 적용된다. |
| `rotate-key` | 연결 키를 교체한다. 서버를 다시 시작하고 새 연결 문자열을 앱에 붙여 넣는다. |
| `--version` | 브리지 버전을 표시한다. |

## 플러그인

Obsidian 커뮤니티 플러그인처럼 파일 하나가 플러그인 하나다. 설정 파일 옆 `plugins` 폴더(`plugins` 명령으로 위치 확인)에 `.mjs` 파일을 넣고 `enable-plugin <id>`로 켠다. 켜기 전에는 불러오기만 하고 쓰지 않는다.

```js
export default {
  id: 'my-ai',                                  // 모델 접두사: 앱에는 my-ai/<모델>로 보인다
  label: 'My AI',
  async models(ctx) { return ['default']; },    // 접두사 뒤 모델 이름 목록
  async chat(model, request, ctx) {             // 답의 글자만 돌려준다
    return '답변';
  },
};
```

- `request`: `{ messages: [{ role, content }], maxTokens, temperature }`
- `ctx.settings`: 설정 파일 `plugins.<id>.settings` 값
- `ctx.signal`: 시간이 초과되면 취소되는 신호. `fetch`에 그대로 넘긴다.
- id는 소문자, 숫자, `-`만 쓰고 기존 공급원(ollama, openai 등)과 겹치면 안 된다. 잘못된 파일은 `list`와 `plugins`에 오류로 표시되고 다른 기능은 계속 동작한다.
- 예시: `examples/echo-plugin.mjs`

플러그인은 이 PC의 권한으로 실행된다. 직접 만들었거나 내용을 확인한 파일만 켠다. 앱(휴대폰)은 플러그인 코드를 내려받아 실행하지 않고, 브리지가 보여 주는 모델 목록에서 고르기만 한다.

## 보안과 검증 범위

- 연결 문자열에는 접속 키가 포함된다. 비밀번호처럼 보관하고 외부 접속에는 HTTPS 역방향 프록시나 Tailscale을 사용한다. 키가 노출되면 `rotate-key`를 실행한다.
- `add-key`로 입력하는 API 키는 터미널 화면에 보이며 브리지 설정에 저장된다. 화면 공유를 끈 상태에서 입력한다.
- 구독 CLI는 서버 주인 본인만 사용한다. Codex에는 도구를 끄는 옵션이 없어 브리지가 적용하는 제한은 읽기 전용 샌드박스까지다.
- 2026-11-25 확인: Windows PC에서 Ollama `gemma3:1b`를 브리지로 연결해 Galaxy S22 앱이 모델 목록을 불러왔고, 같은 주소와 키로 보낸 대화 요청이 한국어 답을 받았다. 예시 플러그인을 켜자 앱 모델 목록에 `echo/default`가 나타났고, Windows 실행 파일(`.exe`)도 같은 플러그인을 불러와 `list`에 표시했다. 앱 화면 안에서 대화를 보내 답이 표시되는 흐름, Codex CLI와 OpenAI·Anthropic·Gemini 실제 키 호출은 미검증이다.
