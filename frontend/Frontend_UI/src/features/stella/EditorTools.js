import { SheetModal } from "../../shared/components/Motion";
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { runtime } from '../../integration/runtime';
import { getMemo } from '../../data/memos/MemoStore';
import ConfirmDialog from '../../shared/components/ConfirmDialog';
import { ROUTES } from '../../navigation/routes';
import { palette as c, styles as s } from './theme';
import Icon from '../../shared/components/Icon';
export default function EditorTools({
  visible,
  onClose,
  flush,
  onReplace,
  navigation,
  onAdvanced,
  draft,
  readOnly,
  memoId,
  favorite,
  onFavorite,
  editorMode,
  onToggleEditor
}) {
  const own = runtime();
  const [panel, setPanel] = useState('menu');
  const [error, setError] = useState('');
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [, update] = useState(0);
  const memo = visible && memoId ? getMemo(memoId) : null;
  const docs = own.documents.listDocuments();
  const current = docs.find(document => document.id === memo?.id);
  function run(action) {
    try {
      const saved = flush();
      if (!saved) {
        setError('문서를 먼저 작성해 주세요. 저장 오류가 있으면 해결한 뒤 다시 시도하세요.');
        return;
      }
      action(saved);
      setError('');
      update(n => n + 1);
    } catch (e) {
      setError(e.message);
    }
  }
  function close() {
    setPanel('menu');
    setError('');
    setSelectedVersion(null);
    onClose();
  }
  function row(label, icon, action, disabled = false) {
    return <Pressable key={label} accessibilityRole="button" disabled={disabled} accessibilityState={{
      disabled
    }} onPress={action} style={[s.menuRow, disabled && {
      opacity: .45
    }]}><Icon name={icon} size={18} color={c.muted} /><Text style={s.menuLabel}>{label}</Text><Icon name="chevronRight" size={14} color={c.subtle} /></Pressable>;
  }
  const versions = memo ? own.documents.listVersions(memo.id) : [];
  const original = memo && panel === 'original' ? own.documents.original(memo.id) : null;
  const links = memo ? own.documents.links() : [];
  return <><SheetModal visible={visible} onClose={close} label="문서 도구"><View style={s.handle} /><View style={s.titleRow}><Text style={s.sectionTitle}>{{
            menu: '문서 도구',
            versions: '저장 버전',
            original: '원문과 출처',
            move: '문서 이동',
            links: '문서 연결',
            compare: '저장본과 비교'
          }[panel]}</Text><Pressable accessibilityRole="button" accessibilityLabel="문서 도구 닫기" onPress={close} style={s.iconButton}><Icon name="x" size={20} color={c.text} /></Pressable></View>{error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}<ScrollView showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false}>
    {panel === 'menu' && <>
      {row(favorite ? '즐겨찾기 해제' : '즐겨찾기에 추가', favorite ? 'starFilled' : 'star', onFavorite, readOnly)}
      {row(editorMode === 'blocks' ? '텍스트로 편집' : '블록으로 편집', 'type', onToggleEditor, readOnly)}
      {row('현재 버전 저장', 'check', () => run(saved => {
            const number = own.documents.createVersion(saved.id, saved.revision);
            setPanel('versions');
            setSelectedVersion(null);
            setError(`버전 ${number} 저장됨`);
          }), readOnly)}
      {row('버전 기록 / 복원', 'clock', () => setPanel('versions'))}
      {row('원문 / 출처 보기', 'file', () => setPanel('original'))}
      {row('저장본과 비교', 'compare', () => setPanel('compare'))}
      {row('하위 문서 만들기', 'plus', () => run(saved => {
            close();
            navigation.navigate(ROUTES.MemoEdit, {
              parentId: saved.id
            }, { push: true });
          }), readOnly)}
      {row('문서 이동 / 순서', 'sort', () => setPanel('move'), readOnly)}
      {row('문서 간 연결', 'link', () => setPanel('links'), readOnly)}
      {row('필기 / 사진 / 기존 편집 도구', 'pencil', () => {
            close();
            onAdvanced();
          })}
      {row('휴지통으로 이동', 'trash', () => setConfirmation('trash'), readOnly)}
    </>}
    {panel === 'versions' && <>{!versions.length && <Text style={s.empty}>저장한 버전이 없습니다.{'\n'}문서 도구의 ‘현재 버전 저장’으로 기록하세요.</Text>}{versions.map(version => row(`버전 ${version.number}  /  ${new Date(version.createdAt).toLocaleString('ko-KR')}`, 'clock', () => setSelectedVersion(version)))}{selectedVersion && <View style={{
            paddingVertical: 18
          }}><Text style={s.sectionTitle}>{selectedVersion.title || '제목 없는 문서'}</Text><Text selectable style={s.proposalBody}>{selectedVersion.body}</Text><Pressable accessibilityRole="button" disabled={readOnly} onPress={() => setConfirmation('restore')} style={[s.primary, {
              marginTop: 18
            }]}><Text style={s.primaryText}>이 버전 복원</Text></Pressable></View>}</>}
    {panel === 'original' && original && <><Text style={s.note}>{original.capturedAt ? `${new Date(original.capturedAt).toLocaleString('ko-KR')}  /  이 기기에서 편집 전에 보존한 원문` : '이 문서는 아직 보존한 이전 원문이 없어 현재 저장본을 표시합니다.'}</Text><Text selectable style={s.proposalBody}>{original.body}</Text><Text style={[s.sectionTitle, {
            marginTop: 20
          }]}>연결된 출처 / 문서</Text>{links.filter(link => link.source === memo.id || link.target === memo.id).map(link => {
            const target = docs.find(document => document.id === (link.source === memo.id ? link.target : link.source));
            return target && row(target.title || '제목 없는 문서', 'link', () => {
              close();
              navigation.navigate(ROUTES.MemoEdit, {
                memoId: target.id
              });
            });
          })}</>}
    {panel === 'compare' && <><Text style={s.note}>입력 중인 내용과 최신 저장본을 읽기 전용으로 비교합니다. 자동 병합하거나 덮어쓰지 않습니다.</Text><Text style={[s.sectionTitle, {
            marginTop: 18
          }]}>입력 중</Text><Text selectable style={s.proposalBody}>{draft.title}{'\n\n'}{draft.body}</Text><Text style={[s.sectionTitle, {
            marginTop: 18
          }]}>기기 저장본</Text><Text selectable style={s.proposalBody}>{memo ? getMemo(memo.id)?.title : ''}{'\n\n'}{memo ? getMemo(memo.id)?.body : '새 문서'}</Text><Pressable accessibilityRole="button" onPress={() => setConfirmation('reload')} style={[s.secondary, {
            marginTop: 18
          }]}><Text style={s.secondaryText}>최신 저장본 다시 불러오기</Text></Pressable></>}
    {panel === 'move' && <>{row('최상위 문서로 이동', 'file', () => run(saved => own.documents.moveDocument(saved.id)))}{row('같은 단계에서 위로 이동', 'chevronUp', () => run(saved => {
            const siblings = docs.filter(document => document.parentId === current?.parentId);
            const index = siblings.findIndex(document => document.id === saved.id);
            if (index > 0) own.documents.moveDocument(saved.id, current?.parentId, siblings[index - 1].id);
          }))}{row('같은 단계에서 아래로 이동', 'chevronDown', () => run(saved => {
            const siblings = docs.filter(document => document.parentId === current?.parentId);
            const index = siblings.findIndex(document => document.id === saved.id);
            if (index < siblings.length - 1) own.documents.moveDocument(saved.id, current?.parentId, siblings[index + 2]?.id ?? null);
          }))}<Text style={s.note}>아래 문서의 하위로 이동</Text>{docs.filter(document => document.id !== memo?.id).map(document => row(document.title || '제목 없는 문서', 'file', () => run(saved => own.documents.moveDocument(saved.id, document.id))))}</>}
    {panel === 'links' && <><Text style={s.note}>선택한 문서와 연결합니다. 연결은 관계도에 표시됩니다.</Text>{docs.filter(document => document.id !== memo?.id).map(document => {
            const linked = links.some(link => [link.source, link.target].includes(memo?.id) && [link.source, link.target].includes(document.id));
            return <Pressable key={document.id} accessibilityRole="checkbox" accessibilityState={{
              checked: linked
            }} onPress={() => run(saved => own.documents.setLink(saved.id, document.id, !linked))} style={s.menuRow}><Icon name={linked ? 'checkSquare' : 'square'} size={19} color={c.text} /><Text style={s.menuLabel}>{document.title || '제목 없는 문서'}</Text></Pressable>;
          })}</>}
    {panel !== 'menu' && row('문서 도구로 돌아가기', 'chevronLeft', () => {
          setPanel('menu');
          setError('');
        })}
    </ScrollView></SheetModal><ConfirmDialog visible={Boolean(confirmation)} title={confirmation === 'trash' ? '문서를 휴지통으로 옮길까요?' : confirmation === 'restore' ? '선택한 버전을 복원할까요?' : '입력 내용을 최신 저장본으로 바꿀까요?'} sub={confirmation === 'trash' ? '휴지통에서 복원할 수 있습니다. 하위 문서는 상위 단계로 이동합니다.' : confirmation === 'restore' ? '현재 저장본도 버전으로 보존한 후 복원합니다.' : '현재 입력 중인 내용은 바뀝니다. 필요한 내용을 먼저 복사해 두세요.'} confirmText="확인" onCancel={() => setConfirmation(null)} onConfirm={() => {
      const action = confirmation;
      setConfirmation(null);
      if (action === 'reload' && memo) {
        try {
          const latest = getMemo(memo.id);
          if (!latest) throw new Error('문서를 찾을 수 없습니다');
          onReplace(latest, own.documents.blocksFor(latest));
          close();
        } catch (e) {
          setError(e.message);
        }
        return;
      }
      run(saved => {
        if (action === 'trash') {
          own.documents.trash(saved.id);
          close();
          navigation.goBack();
        } else if (selectedVersion) {
          const restored = own.documents.restoreVersion(saved.id, selectedVersion.number, saved.revision);
          onReplace(restored, own.documents.blocksFor(restored));
          close();
        }
      });
    }} /></>;
}
