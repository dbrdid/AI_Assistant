# stella-audio-split (Expo 로컬 모듈)

녹음 파일(m4a)을 **다시 인코딩하지 않고** 약 2분 구간 파일로 자릅니다 (구간 길이는 1~15분 설정 가능). 긴 녹음(최대 3시간)을 서버에 구간별로 올릴 때 씁니다.

> ⚠️ **연결·검증 필요**: 이 환경에서는 iOS·Android 빌드를 할 수 없어서 실제 기기에서 확인하지 못했어요. 프론트엔드 팀이 개발 빌드로 확인해 주세요.

## 넣는 방법
1. 이 폴더를 앱 루트의 `modules/stella-audio-split`에 복사 (Expo SDK 52+는 `modules/` 아래를 자동 연결)
2. `npx expo prebuild` 후 개발 빌드 (`npx expo run:ios` / `npx expo run:android`). Expo Go에서는 안 돼요
3. `import { getAudioDuration, splitAudio } from '@/modules/stella-audio-split'` (경로 별칭은 앱 설정에 맞게)

## 사용
```ts
const total = await getAudioDuration(recorder.uri);                    // 초
const plan = planSegments(total);                                      // @/lib/stella: 약 2분씩, 마지막 30초 미만은 앞에 붙임
const segs = await splitAudio(recorder.uri, plan.map((p) => ({ start: p.startSeconds, duration: p.durationSeconds })));
// segs: [{ seq, uri: 'file://…/000.m4a', startSeconds, durationSeconds, sizeBytes }]
```
- 원본은 건드리지 않아요. 구간 파일은 업로드가 서버에서 확인되면 지우고, 전부 확인되면 원본을 지우세요.
- 출력 폴더 기본값: 앱 캐시 폴더 `stella-split/<무작위>/`

## 동작
| | iOS | Android |
|---|---|---|
| 방식 | `AVAssetExportSession` + `timeRange` (가능하면 Passthrough, 안 되면 AAC로 다시 인코딩) | `MediaExtractor`로 AAC 프레임을 읽어 `MediaMuxer`로 그대로 씀 |
| 경계 | 지정한 시각 (AAC 패킷 단위) | 시작 시각 이후 프레임부터, 다음 구간은 앞 구간이 멈춘 프레임부터 → 겹침·빠짐 없음 |
| 최소 버전 | iOS 15.1 | Expo SDK 52+ (`expo-module-gradle-plugin`) |

## 확인할 것 (기기에서)
- [ ] 3시간 녹음 → 90개 구간(2분), 각 구간 재생·길이 합계가 원본과 같은지
- [ ] 구간 경계에서 말이 끊기거나 겹치지 않는지 (구간 끝 1초·다음 구간 앞 1초 들어 보기)
- [ ] 구간 파일을 `uploadRecordingSegments`로 올렸을 때 서버 전사가 되는지 (iOS Passthrough m4a, Android MediaMuxer m4a 둘 다)
- [ ] 저장공간: 3시간 64kbps ≈ 원본 86MB + 구간 86MB
