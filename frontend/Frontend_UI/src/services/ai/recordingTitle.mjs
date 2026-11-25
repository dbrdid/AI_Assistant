// 녹음 메모 제목: 앞의 "녹음 "을 지킨다 (회의 안건 판단 AgendaJudge가 /^녹음\s/로 녹음 메모를 알아봄)
export const recordingTitle = aiTitle => `녹음 ${String(aiTitle ?? '').replace(/^녹음\s*[:：-]?\s*/, '').trim()}`.slice(0, 60);
