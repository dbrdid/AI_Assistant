# Stella 브리지 0.1.0

브리지는 내 컴퓨터의 로컬 모델, API 제공자, 로그인된 CLI를 Stella 메모앱의 **내 서버** 연결로 사용할 수 있게 한다. 모델이나 CLI를 실행할 컴퓨터에 메모앱과 별도로 설치한다.

## 설치

**Windows**에서는 릴리스 `bridge-v0.1.0`에서 `stella-bridge.exe`와 `SHA256SUMS`를 같은 폴더에 내려받는다. PowerShell에서 아래 해시를 구해 `SHA256SUMS`의 실행 파일 항목과 일치하는지 확인한다. 실행 파일에 코드 서명이 없어 SmartScreen 경고가 나타날 수 있다.

```powershell
Get-FileHash .\stella-bridge.exe -Algorithm SHA256
```

**macOS·Linux**에서는 Node.js 20 이상을 설치하고 같은 릴리스의 npm 패키지(`.tgz`)를 내려받는다. 아래 명령에서 파일명을 실제 다운로드한 이름으로 바꾼다.

```sh
npm i -g ./패키지파일명.tgz
```

## 처음 연결하기

1. Windows에서는 실행 파일 폴더에서 `.\stella-bridge.exe init`을, npm 설치본에서는 `stella-bridge init`을 실행한다. 출력된 연결 문자열 한 줄을 복사한다.
2. 같은 컴퓨터에서 `list`로 사용할 모델을 확인한 뒤 `serve`로 서버를 시작한다. Windows에서 전체 명령은 `.\stella-bridge.exe serve`, npm 설치본에서는 `stella-bridge serve`다. 앱에서 사용하는 동안 서버를 켜 둔다.
3. 같은 네트워크의 메모앱에서 **AI 연결 → 내 서버 → 서버 주소**에 연결 문자열 전체를 붙여 넣는다. 주소와 이번 앱 실행에 쓸 연결 키가 채워지면 **서버에서 불러오기**로 모델을 선택한다.

## 명령

아래 명령은 `stella-bridge` 또는 `.\stella-bridge.exe` 뒤에 붙인다.

| 명령 | 용도 |
| --- | --- |
| `init` | 최초 설정을 만들고 연결 문자열을 출력한다. |
| `serve [--host 0.0.0.0] [--port 8787]` | 지정한 호스트와 포트에서 브리지를 실행한다. |
| `list` | 제공자별 연결 상태와 사용 가능한 모델 ID를 표시한다. |
| `add-key <openai\|anthropic\|gemini> [모델...]` | 제공자의 API 키를 입력하고 사용할 모델을 지정한다. |
| `add-key openai-compatible <이름> <주소>` | OpenAI 호환 서버를 등록한다. 키가 필요 없으면 입력창에서 Enter를 누른다. |
| `enable-cli <claude\|codex>` | 서버에 설치하고 로그인한 CLI를 켠다. |
| `disable-cli [이름]` | 지정한 CLI를 끈다. 이름을 생략하면 모두 끈다. |
| `rotate-key` | 연결 키를 교체한다. 서버를 다시 시작하고 새 연결 문자열을 앱에 붙여 넣는다. |
| `--version` | 브리지 버전을 표시한다. |

## 보안과 검증 범위

- 연결 문자열에는 접속 키가 포함된다. 비밀번호처럼 보관하고 외부 접속에는 HTTPS 역방향 프록시나 Tailscale을 사용한다.
- `add-key`로 입력하는 API 키는 터미널 화면에 보이며 브리지 설정에 저장된다. 화면 공유를 끈 상태에서 입력한다.
- 구독 CLI는 서버 주인 본인만 사용한다. Windows 실행 파일로 브리지를 실행해도 Codex CLI에는 별도의 Node.js가 필요하다. Codex에는 도구를 끄는 옵션이 없어 브리지가 적용하는 제한은 읽기 전용 샌드박스까지다.
- Claude CLI의 실제 응답 1회를 확인했다. Claude Code가 웹 미리보기에서 연결 문자열을 붙여 넣자 주소만 표시됐고, 키는 숨겨진 채 모델 목록을 불러왔다. Node.js 없는 Windows 환경에서 실행 파일의 `init`·`list`·`serve` 동작과 연결 키 없는 요청의 HTTP 401 응답을 확인했다. Codex CLI 실제 호출과 OpenAI·Anthropic·Gemini 실제 API 키 호출은 미검증(NOT_RUN)이다.
