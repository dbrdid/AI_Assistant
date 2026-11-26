// 여러 작업 요청("…추가하고 …", "그리고", 쉼표)을 작업별 조각으로 나눈다. 각 작업은 자기 조각에 대해 같은 검사를 받는다.
// appCommands.mjs는 S22 평가 설정에 해시가 고정된 명령 프롬프트 파일이라 이 함수는 여기에 따로 둔다.
export function splitRequest(request) {
  // "추가하고" → "추가해줘"처럼 조각 끝을 요청 모양으로 되돌려 같은 검사를 그대로 받게 한다
  const ending = { 만들: '만들어줘', 넣: '넣어줘', 바꾸: '바꿔줘', 바꿔: '바꿔줘', 옮기: '옮겨줘' };
  return String(request).replace(/(추가|생성|등록|만들|넣|바꾸|바꿔|수정|삭제|이동|변경|옮기|체크)(?:하|해)?고\s+/g, (_, verb) => (ending[verb] ?? verb + '해줘') + '\n')
    .replace(/\s*그리고\s*|[,，]\s*/g, '\n').split('\n').map(part => part.trim()).filter(Boolean);
}
