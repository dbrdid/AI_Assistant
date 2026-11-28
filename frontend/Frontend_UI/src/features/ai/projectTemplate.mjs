// AI 채팅에서 "프로젝트 만들어줘": 정해 둔 템플릿의 필수 항목을 채팅 안에서 눌러 고르고, 다 고르면 실제 프로젝트를 만든다.
// 모델 없이 동작하는 순수 함수만 둔다 (화면은 AiChatScreen).

const pad = n => String(n).padStart(2, '0');
const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 마감 선택지: 오늘 기준으로 날짜를 정한다
export function dueOptions(today = new Date()) {
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const friday = new Date(base); friday.setDate(base.getDate() + ((5 - base.getDay() + 7) % 7 || 7));
  const monthEnd = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  const nextMonthEnd = new Date(base.getFullYear(), base.getMonth() + 2, 0);
  return [['이번 주 금요일', key(friday)], ['이번 달 말', key(monthEnd)], ['다음 달 말', key(nextMonthEnd)], ['정하지 않음', '']];
}

// 템플릿: 프로젝트를 만들 때 꼭 정할 항목 (순서대로 묻는다)
export const PROJECT_TEMPLATE = [
  { key: 'title', label: '프로젝트 이름', ask: '프로젝트 이름을 입력해 주세요.' },
  { key: 'status', label: '상태', ask: '지금 상태를 골라 주세요.', options: () => ['진행 전', '진행 중', '완료', '보류'].map(v => [v, v]) },
  { key: 'priority', label: '중요도', ask: '중요도를 골라 주세요.', options: () => ['낮음', '보통', '높음'].map(v => [v, v]) },
  { key: 'due', label: '마감', ask: '마감을 골라 주세요.', options: dueOptions },
];

const GENERIC = /^(?:새|새로운|신규|하나|한\s*개|간단한|내|우리|그|이)$/;
const CREATE_PROJECT = /프로젝트(?:를|을)?(?:\s*(?:하나|한\s*개|새로))*\s*(?:만들(?:어|기)|(?:생성|추가|시작)(?:해|하기)?)(?=\s|[.!?：:]|줘|주세요|$)/u;
/** 프로젝트를 만들어 달라는 요청인지와, 요청에 들어 있는 이름. 예: "신제품 출시 프로젝트 만들어줘" → { title: '신제품 출시' } */
export function parseProjectRequest(text) {
  const t = String(text ?? '').trim();
  if (!CREATE_PROJECT.test(t) || /(삭제|지워|상태\s*변경|연결)/.test(t)) return null;
  const quoted = /["'“‘「『](.+?)["'”’」』]/.exec(t)?.[1];
  const colon = /프로젝트[^:：]*[:：]\s*(.+)$/.exec(t)?.[1];
  const before = /^(.+?)\s*(?:이?라는|이란)?\s*(?:새\s*)?프로젝트/.exec(t)?.[1];
  const title = (quoted || colon || before || '').replace(/(?:을|를|으로|로)$/, '').trim();
  return { title: title && !GENERIC.test(title) ? title.slice(0, 200) : '' };
}

/** 아직 정하지 않은 첫 항목, 다 정했으면 null */
export const nextField = values => PROJECT_TEMPLATE.find(field => !(field.key in values)) ?? null;

/** 지금까지 고른 항목만 한 줄씩 */
export function summary(values) {
  const due = values.due ? values.due.replace(/^(\d+)-(\d+)-(\d+)$/, (_, y, m, d) => `${Number(m)}월 ${Number(d)}일`) : '정하지 않음';
  return [['title', `이름: ${values.title}`], ['status', `상태: ${values.status}`], ['priority', `중요도: ${values.priority}`], ['due', `마감: ${due}`]]
    .filter(([key]) => key in values).map(([, line]) => line).join('\n');
}
