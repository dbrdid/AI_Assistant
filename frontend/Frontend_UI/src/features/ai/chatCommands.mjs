import { routeCommand } from '../stella/appCommands.mjs';
import { isItemCommand } from '../stella/itemCommands.mjs';
import { isProjectCommand } from '../stella/projectCommands.mjs';

const DOCUMENT = /^(?:문서\s*(?:만들기|생성|추가)\s*[:：]|문서\s*제목\s*변경\s*[:：]|(?:상위 문서 변경|문서 연결(?: 해제)?)\s*[:：]|최상위로 이동$)/u;
const BLOCK = /^(?:\d+\s*번\s*블록|(?:문단|본문|제목|목록|체크|표)\s*블록\s*(?:추가|생성))/u;
const CREATE = /^(?:새\s*)?문서\s*(?:만들기|생성|추가)\s*[:：]/u;

export function planChatCommand(input, { memos, recentSources = [] }) {
  const text = input.trim();
  const named = /^["“](.+?)["”]\s*문서(?:에서|의|에)\s*(.+)$/u.exec(text);
  const commandText = named?.[2] ?? text;
  const routed = routeCommand(commandText);
  const blockType = /^(\d+)\s*번\s*블록(?:을|를)?\s*(문단|본문|제목|목록|체크)(?:\s*블록)?\s*(?:으)?로\s*(?:바꿔|변경해|전환해)\s*(?:줘|주세요)[.!?]?$/u.exec(commandText);
  const newDocument = !named && /^(.+?)\s+문서(?:를|을)?\s*(?:만들어|생성해|작성해)\s*(?:줘|주세요)[.!?]?$/u.exec(commandText);
  const command = blockType ? `${blockType[1]}번 블록 종류 변경: ${blockType[2]}`
    : routed.command || (newDocument ? `문서 만들기: ${newDocument[1]}` : commandText);
  if (!(DOCUMENT.test(command) || BLOCK.test(command) || isItemCommand(command) || isProjectCommand(command))) return null;
  if (CREATE.test(command)) return { command, originalRequest: commandText };
  const needsDocument = DOCUMENT.test(command) || BLOCK.test(command);
  if (!needsDocument) return { command, originalRequest: commandText };
  const key = (value = '') => String(value ?? '').normalize('NFC').trim().toLowerCase().replace(/\s+/gu, '');
  const selected = named ? memos.filter(memo => key(memo.title) === key(named[1]))
    : memos.filter(memo => recentSources.some(source => source.type === 'memo' && source.id === memo.id));
  if (selected.length !== 1) return { message: '수정할 문서를 하나 지정해 주세요. 예: “회의록” 문서에서 제목 블록 추가: 결정 사항' };
  return { command, originalRequest: commandText, memoId: selected[0].id, revision: selected[0].revision };
}
