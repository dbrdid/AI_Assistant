// ============================================================
// ProjectDetailScreen.js — 프로젝트 화면
// ============================================================


import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import Icon from '../../../shared/components/Icon';
import { Chip, CircleButton, DashedButton, InlineDeletePrompt, Tag } from '../../../shared/components/Ui';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { useInsets } from '../../../shared/hooks/useInsets';
import { ROUTES } from '../../../navigation/routes';
import { memoTitle, trashMemos, useMemos } from '../../../data/memos/MemoStore';
import { deleteTask, useTasks } from '../../../data/tasks/TaskStore';
import { addAsset, checkAsset, checkCloudAsset, cloudAvailable, deleteFile, downloadFileToDevice, pickAssets, uploadLocalProjectFile, uploadProjectFile, useCloudFiles, useFiles } from '../../../data/files/FileStore';
import { findSharedTableCellConflict, getProject, linkItems, linkProjectFiles, saveSharedProjectTable, unlinkItems, unlinkProjectFiles, useProjects } from '../../../data/projects/ProjectStore';
import { useWorkspaces } from '../../../data/workspaces/WorkspaceStore';
import { maybeRuntime, readPreference, runtime, scoped, writePreference } from '../../../data/hooks';
import { alertUser } from '../../../data/alert';
import { listOutbox } from '../../../lib/stella/local-sync';
import { projectTaskSection } from '../projectTaskKind';
import { canLinkProjectItems, canManageProjectItems } from '../projectPermissions';
import { isProjectLeader } from '../../../lib/stella/project-team';
import ProjectItemsTable from '../components/ProjectItemsTable';
import ProjectTaskBoard from '../components/ProjectTaskBoard';
import { projectTableKey, projectViewKey } from '../../../data/projects/projectTablePreferences.mjs';

// 받침이 있으면 '이', 없으면 '가'(메모가, 할 일이, 파일이, 일정이)
const hasBatchim = word => { const code = String(word).trim().slice(-1).charCodeAt(0) - 0xac00; return code >= 0 && code <= 11171 && code % 28 !== 0; };
export default function ProjectDetailScreen({ navigation, route }) {
  const insets = useInsets();
  const projectId = route?.params?.projectId;
  const projects = useProjects(); // 바뀌면 다시 그리기 위해 구독
  const project = getProject(projectId);
  const memos = useMemos();
  const tasks = useTasks();
  const files = useFiles();
  const cloudFiles = useCloudFiles();          // 공유 공간에 올린 파일 (멤버 모두가 봄)
  const isSharedWorkspace = cloudAvailable();
  const { current: workspace } = useWorkspaces();
  const canCreateMemo = workspace.personal || workspace.roleCode !== 'VIEWER';
  // 관리(팀원 초대와 관리, 프로젝트 편집, 정보 수정, 연결 해제)는 공간 관리자와 프로젝트 팀장만. 개인 공간은 누구나
  const projectLeader = !!project && isProjectLeader((project.members || []).map((member) => ({ account_id: member.accountId ?? null, role: member.role, deleted_at: null })), maybeRuntime()?.session.id);
  const canManageItems = canManageProjectItems({ workspace, projectLeader });
  const canUnlink = canManageItems;
  // 연결은 공간 멤버(관리자와 멤버)까지. 보기 전용은 연결할 수 없음
  const canLink = canLinkProjectItems(workspace);
  const viewKey = scoped(projectViewKey(projectId));
  const tableSettingsKey = scoped(projectTableKey(projectId));
  const [view, setView] = useState(() => readPreference(viewKey, 'list'));
  const changeView = (nextView) => {
    writePreference(viewKey, nextView);
    setView(nextView);
  };

  const [open, setOpen] = useState({ memos: true, todos: false, files: false, events: false });
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState([]);       // 편집 모드에서 체크한 항목 키 ('kind:id')
  const [adding, setAdding] = useState(null);      // 연결 추가 창: 'memos' | 'todos' | 'files' | 'events' | null
  const [addPicked, setAddPicked] = useState([]);
  const [moving, setMoving] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [importingFiles, setImportingFiles] = useState(false);
  const [fileImportMessage, setFileImportMessage] = useState('');
  const [downloadingFileId, setDownloadingFileId] = useState(null);

  // 공유 프로젝트의 동기화 상태: 문제가 있거나 아직 보내는 중일 때만 한 줄로 알림
  const [syncInfo, setSyncInfo] = useState({ loading: false, message: '' });
  const refreshSyncInfo = async () => {
    const own = maybeRuntime();
    if (!own || !workspace || workspace.personal) return setSyncInfo({ loading: false, message: '' });
    if (!workspace.serverId) return setSyncInfo({ loading: false, message: '이 공간은 아직 서버와 연결되지 않았어요.' });
    try {
      const status = await own.bridge.status(workspace.id);
      const mine = status.workspaces?.[workspace.id];
      const head = (await listOutbox(own.syncDb, workspace.serverId))[0];
      const detail = head?.lastError ? `\n${head.lastError}` : '';
      if (maybeRuntime() !== own) return;
      if (status.state === 'needs_login') setSyncInfo({ loading: false, message: '로그인이 만료됐어요. 다시 로그인해 주세요.' });
      else if (mine?.conflicts) setSyncInfo({ loading: false, message: `다른 기기와 충돌한 변경이 있어요.${detail}` });
      else if (mine?.failed || mine?.lastError) setSyncInfo({ loading: false, message: `서버에 반영하지 못한 변경이 있어요.${mine.lastError ? `\n${mine.lastError}` : detail}` });
      else if ((mine?.pending ?? 0) > 0 || (mine?.waiting ?? 0) > 0) setSyncInfo({ loading: false, message: '변경을 서버에 보내는 중이에요.' });
      else setSyncInfo({ loading: false, message: '' });
    } catch (error) {
      setSyncInfo({ loading: false, message: error?.message || '동기화 상태를 확인하지 못했어요.' });
    }
  };
  const retrySync = async () => {
    setSyncInfo(prev => ({ ...prev, loading: true }));
    try { await runtime().bridge.syncWorkspace(workspace.id); } catch { /* 아래에서 상태를 다시 읽어 알림 */ }
    await refreshSyncInfo();
  };
  useEffect(() => { void refreshSyncInfo(); }, [projectId, workspace?.id, projects]);

  // 구역별 "연결된 항목" / "연결할 수 있는 후보" 계산
  const sections = useMemo(() => {
    if (!project) return [];
    const L = project.links;
    const inL = (kind, id) => L[kind].includes(id);
    const taskKind = (t) => projectTaskSection(t);   // 종류가 없는 예전 기록은 시작 시각이 있으면 일정
    return [
      { key: 'memos', kind: 'memos', label: '메모', unit: '개', all: memos.map((m) => ({ id: m.id, title: memoTitle(m), date: new Date(m.updatedAt).toLocaleDateString('sv-SE'), sub: `수정 ${new Date(m.updatedAt).getMonth() + 1}/${new Date(m.updatedAt).getDate()}` })) },
      { key: 'todos', kind: 'tasks', label: '할 일', unit: '개', all: tasks.filter((t) => taskKind(t) === 'todos').map((t) => ({ id: t.id, title: t.title, date: t.date, status: t.status, sub: `${t.date.slice(5).replace('-', '/')}, ${t.status}` })) },
      { key: 'files', kind: 'files', label: '파일', unit: '개', all: [
        ...files.map((f) => ({ id: f.id, title: f.name, sub: `${isSharedWorkspace ? '기기, ' : ''}${f.kind}, ${f.size}`, isCloud: false })),
        ...cloudFiles.map((f) => ({ id: f.id, title: f.name, sub: `클라우드, ${f.kind}, ${f.size}`, isCloud: true })),
      ] },
      { key: 'events', kind: 'tasks', label: '일정', unit: '개', all: tasks.filter((t) => taskKind(t) === 'events').map((t) => ({ id: t.id, title: t.title, date: t.date, status: t.status, sub: `${t.date.slice(5).replace('-', '/')} ${t.start}` })) },
    ].map((s) => ({ ...s, items: s.all.filter((x) => inL(s.kind, x.id)), candidates: s.all.filter((x) => !inL(s.kind, x.id)) }));
  }, [project, memos, tasks, files, cloudFiles, isSharedWorkspace]);

  if (!project) {
    return (
      <View style={styles.root}>
        <ScreenHeader title="프로젝트" onBack={navigation.goBack} />
        <Text style={styles.gone}>프로젝트를 찾을 수 없어요.</Text>
      </View>
    );
  }

  const otherProjects = projects.filter((p) => p.id !== project.id);
  const keyOf = (s, id) => `${s.key}:${id}`;
  const allKeys = sections.flatMap((s) => s.items.map((x) => keyOf(s, x.id)));
  const toggle = (k) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  const pickedBySection = (fn) =>
    sections.forEach((s) => {
      const ids = s.items.filter((x) => picked.includes(keyOf(s, x.id))).map((x) => x.id);
      if (ids.length) fn(s, ids);
    });
  const exitEdit = () => {
    setEditing(false);
    setPicked([]);
  };
  const selectedBySection = () => sections.map((s) => ({ section: s, ids: s.items.filter((x) => picked.includes(keyOf(s, x.id))).map((x) => x.id) })).filter((g) => g.ids.length);
  const isCloudItem = (section, id) => Boolean(section.all.find((item) => item.id === id)?.isCloud);
  const hasCloudPicked = selectedBySection().some(({ section, ids }) => section.kind === 'files' && ids.some((id) => isCloudItem(section, id)));

  // 기기 파일을 공유 공간 클라우드에 올림 (프로젝트 팀원과 공유). 올린 것과 실패한 것을 나눠 돌려줌
  const uploadLocalFiles = async (ids) => {
    const uploaded = [];
    const failures = [];
    for (const id of ids) {
      try { uploaded.push({ sourceId: id, assetId: (await uploadLocalProjectFile(id)).id }); }
      catch (error) { failures.push(`${files.find((item) => item.id === id)?.name || '파일'}: ${error.message || '클라우드에 올리지 못했어요'}`); }
    }
    return { uploaded, failures };
  };
  // 파일 연결: 공유 공간은 클라우드 파일로(project_files, 팀원과 동기화), 개인 공간은 기기 연결
  const linkFiles = async (targetProjectId, section, ids) => {
    if (!isSharedWorkspace) {
      if (ids.length && !linkItems(targetProjectId, 'files', ids)) throw new Error('기기 파일을 연결하지 못했어요');
      return [];
    }
    const cloudIds = ids.filter((id) => isCloudItem(section, id));
    const { uploaded, failures } = await uploadLocalFiles(ids.filter((id) => !cloudIds.includes(id)));
    const assetIds = [...cloudIds, ...uploaded.map((file) => file.assetId)];
    if (assetIds.length) await linkProjectFiles(targetProjectId, assetIds);
    if (uploaded.length) unlinkItems('files', uploaded.map((file) => file.sourceId));
    return failures;
  };
  const importPhoneFiles = async () => {
    setFileImportMessage('');
    setImportingFiles(true);
    try {
      const ids = [];
      const failures = [];
      for (const asset of await pickAssets()) {
        const check = isSharedWorkspace ? checkCloudAsset(asset) : checkAsset(asset);
        if (!check.ok) { failures.push(`${asset.name || '파일'}: ${check.reason}`); continue; }
        try { ids.push(isSharedWorkspace ? (await uploadProjectFile(asset)).id : (await addAsset(asset, {}, { referenceOnly: true })).id); }
        catch (error) { failures.push(`${asset.name || '파일'}: ${error.message || '가져오지 못했어요'}`); }
      }
      if (ids.length) {
        try {
          if (isSharedWorkspace) await linkProjectFiles(project.id, ids);
          else if (!linkItems(project.id, 'files', ids)) throw new Error('프로젝트에 연결하지 못했어요');
        } catch (error) {
          failures.push(`${ids.length}개 파일은 저장했지만 프로젝트에 연결하지 못했어요. ${error.message || ''}`.trim());
        }
      }
      if (failures.length) setFileImportMessage(`${failures.slice(0, 3).join('\n')}${failures.length > 3 ? `\n외 ${failures.length - 3}개 실패` : ''}`);
      else if (ids.length) { setAdding(null); setAddPicked([]); }
    } catch (error) {
      setFileImportMessage(error.message || '기기에서 파일을 가져오지 못했어요.');
    } finally {
      setImportingFiles(false);
      void refreshSyncInfo();
    }
  };
  const downloadProjectFile = async (id) => {
    if (downloadingFileId) return;
    setDownloadingFileId(id);
    try {
      const savedName = await downloadFileToDevice(id);
      if (savedName) alertUser('다운로드 완료', `${savedName} 파일을 기기에 저장했어요.`);
    } catch (error) {
      alertUser('파일을 저장하지 못했어요', error.message || '다시 시도해 주세요.');
    } finally {
      setDownloadingFileId(null);
    }
  };
  const linkPicked = async () => {
    const section = sections.find((q) => q.key === adding);
    if (!section) return;
    try {
      if (section.kind !== 'files') linkItems(project.id, section.kind, addPicked);
      else {
        const failures = await linkFiles(project.id, section, addPicked);
        if (failures.length) alertUser('일부 기기 파일을 올리지 못했어요', failures.slice(0, 3).join('\n'));
      }
      setAdding(null);
    } catch (error) {
      alertUser('항목을 연결하지 못했어요', error.message || '다시 시도해 주세요.');
    }
    void refreshSyncInfo();
  };
  const movePicked = async (targetProjectId) => {
    try {
      for (const { section, ids } of selectedBySection()) {
        if (section.kind !== 'files') linkItems(targetProjectId, section.kind, ids);
        else {
          const failures = await linkFiles(targetProjectId, section, ids);
          if (failures.length) alertUser('일부 기기 파일을 이동하지 못했어요', failures.slice(0, 3).join('\n'));
        }
      }
      setMoving(false);
      exitEdit();
    } catch (error) {
      alertUser('항목을 이동하지 못했어요', error.message || '다시 시도해 주세요.');
    }
  };
  const unlinkPicked = async () => {
    try {
      for (const { section, ids } of selectedBySection()) {
        if (section.kind !== 'files') { unlinkItems(section.kind, ids); continue; }
        const cloudIds = ids.filter((id) => isCloudItem(section, id));
        const localIds = ids.filter((id) => !cloudIds.includes(id));
        if (localIds.length) unlinkItems('files', localIds);
        if (cloudIds.length) await unlinkProjectFiles(project.id, cloudIds);
      }
      setConfirmUnlink(false);
      exitEdit();
    } catch (error) {
      setConfirmUnlink(false);
      alertUser('연결을 해제하지 못했어요', error.message || '다시 시도해 주세요.');
    }
  };
  // 연결할 항목이 없을 때 이 프로젝트에 바로 만들기
  const createForProject = (key) => {
    setAdding(null);
    if (key === 'memos') navigation.navigate(ROUTES.MemoEdit, { projectId });
    else navigation.navigate(ROUTES.TaskEdit, { kind: key === 'events' ? 'event' : 'task', projectId });
  };

  const openItem = (s, id) => {
    if (s.kind === 'memos') navigation.navigate(ROUTES.MemoEdit, { memoId: id });
    else if (s.kind === 'tasks') navigation.navigate(ROUTES.TaskEdit, { taskId: id });
    else navigation.navigate(ROUTES.Files, { focusId: id });
  };
  const deletePicked = () => {
    if (!picked.length || hasCloudPicked) return;
    try {
      pickedBySection((section, ids) => {
        if (section.kind === 'memos') trashMemos(ids);
        else if (section.kind === 'tasks') ids.forEach(id => deleteTask(id));
        else ids.forEach(id => deleteFile(id));
      });
      exitEdit();
    } catch (error) {
      alertUser('항목을 삭제하지 못했어요', error.message || '다시 시도해 주세요.');
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader
        title={project.title}
        onBack={navigation.goBack}
        right={canManageItems ? <CircleButton icon="userPlus" label="팀원 초대" onPress={() => navigation.navigate(ROUTES.ProjectInvite, { projectId })} /> : null}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {/* 프로젝트 정보: 상태 꼬리표 + 마감, 담당, 장소 (있는 값만) */}
        <View style={[styles.section, styles.info]}>
          <View style={styles.infoRow}>
            <Tag label={project.status} tone={project.status === '진행 중' ? 'mint' : project.status === '완료' ? 'muted' : 'outline'} />
            {!!project.due && (
              <View style={styles.metaItem}>
                <Icon name="calendar" size={15} color={colors.muted} />
                <Text style={styles.infoLine}>마감 {project.due}</Text>
              </View>
            )}
            {!!project.assignee && <Text style={styles.infoLine}>담당 {project.assignee}</Text>}
            {!!project.place && <Text style={styles.infoLine}>{project.place}</Text>}
          </View>
          {!!project.desc && <Text style={styles.desc}>{project.desc}</Text>}
        </View>
        {!!syncInfo.message && (
          <View style={styles.syncNotice}>
            <Text accessibilityLiveRegion="polite" style={styles.syncText}>{syncInfo.loading ? '동기화 상태 확인 중…' : syncInfo.message}</Text>
            {!syncInfo.loading && (
              <Pressable accessibilityRole="button" onPress={retrySync} style={styles.syncRetry}>
                <Text style={styles.linkText}>다시 동기화</Text>
              </Pressable>
            )}
          </View>
        )}

        <View style={styles.viewHeader}>
          <Text accessibilityRole="header" style={styles.heading}>연결된 항목</Text>
          {!editing && <View style={styles.viewControls}>
            <Chip label="목록" active={view === 'list'} onPress={() => changeView('list')} />
            <Chip label="표" active={view === 'table'} onPress={() => changeView('table')} />
            <Chip label="보드" active={view === 'board'} onPress={() => changeView('board')} />
          </View>}
        </View>
        {!editing && canCreateMemo && (
          <DashedButton label="이 프로젝트에 새 메모" onPress={() => navigation.navigate(ROUTES.MemoEdit, { projectId })} style={styles.linkBtn} />
        )}

        {!editing && view === 'table' ? (
          <ProjectItemsTable
            initialSettings={readPreference(tableSettingsKey, null)}
            onSaveSettings={next => writePreference(tableSettingsKey, next)}
            sharedTable={project.sharedTable}
            canEditSharedTable={project.canEditSharedTable}
            onSaveSharedTable={(expected, table) => saveSharedProjectTable(projectId, expected, table)}
            onFindCellConflict={(rowKey, key) => findSharedTableCellConflict(projectId, rowKey, key)}
            sections={sections}
            onOpen={openItem}
          />
        ) :
          !editing && view === 'board' ? (
            <ProjectTaskBoard
              tasks={tasks.filter(task => task.kind === 'task' && project.links.tasks.includes(task.id))}
              canEdit={canCreateMemo}
              onOpen={taskId => navigation.navigate(ROUTES.TaskEdit, { taskId })}
            />
          ) : sections.map((s) => {
          const isOpen = open[s.key] || editing;
          return (
            <View key={s.key} style={styles.section}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: isOpen }} onPress={() => setOpen((o) => ({ ...o, [s.key]: !o[s.key] }))} style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>{s.label}{s.items.length > 0 && <Text style={styles.sectionCount}>  {s.items.length}</Text>}</Text>
                <Icon name="chevronDown" size={18} color={colors.muted} style={isOpen ? styles.flip : undefined} />
              </Pressable>
              {isOpen && (
                <View style={{ gap: spacing.sm }}>
                  {s.items.length === 0 && <Text style={styles.none}>연결된 {s.label}{hasBatchim(s.label) ? '이' : '가'} 없어요</Text>}
                  {s.items.map((x) => {
                    const k = keyOf(s, x.id);
                    const on = picked.includes(k);
                    const row = (
                      <Pressable
                        key={x.id}
                        accessibilityRole={editing ? 'checkbox' : 'button'}
                        accessibilityState={editing ? { checked: on } : undefined}
                        onPress={() => (editing ? toggle(k) : openItem(s, x.id))}
                        onLongPress={() => {
                          if (!editing) {
                            setEditing(true);
                            setPicked([k]);
                          }
                        }}
                        delayLongPress={350}
                        style={[styles.item, on && styles.itemOn, x.isCloud && !editing && { flex: 1 }]}
                      >
                        {editing && <Icon name={on ? 'checkSquare' : 'square'} size={22} color={on ? colors.ink : colors.muted} />}
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text style={styles.itemTitle} numberOfLines={1}>{x.title}</Text>
                          <Text style={styles.itemSub} numberOfLines={1}>{x.sub}</Text>
                        </View>
                      </Pressable>
                    );
                    if (!x.isCloud || editing) return row;
                    return (
                      <View key={x.id} style={styles.fileRow}>
                        {row}
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={downloadingFileId === x.id ? `${x.title} 저장 중` : `${x.title} 내려받기`}
                          disabled={downloadingFileId !== null}
                          onPress={() => downloadProjectFile(x.id)}
                          style={[styles.downloadBtn, downloadingFileId !== null && styles.off]}
                        >
                          {downloadingFileId === x.id ? <ActivityIndicator size="small" color={colors.muted} /> : <Icon name="download" size={20} color={colors.muted} />}
                        </Pressable>
                      </View>
                    );
                  })}
                  {!editing && canLink && (
                    <DashedButton label={`${s.label} 연결`} onPress={() => { setAdding(s.key); setAddPicked([]); }} style={styles.linkBtn} />
                  )}
                </View>
              )}
            </View>
          );
        })}

        {/* 팀원: 관리할 수 있으면 누르면 팀원 관리 화면, 아니면 인원만 보여 줌 */}
        <Pressable accessibilityRole={canManageItems ? 'button' : 'text'} disabled={!canManageItems} onPress={() => navigation.navigate(ROUTES.ProjectTeam, { projectId })} style={[styles.section, styles.sectionHead]}>
          <View style={styles.metaItem}>
            <Icon name="users" size={18} color={colors.mintDark} />
            <Text style={styles.sectionTitle}>팀원 {project.members.length}명</Text>
          </View>
          {canManageItems && <Icon name="chevronRight" size={18} color={colors.muted} />}
        </Pressable>

        {!editing && canManageItems && (
          <View style={styles.bottomRow}>
            <Pressable accessibilityRole="button" onPress={() => setEditing(true)} style={({ pressed }) => [styles.textBtn, pressed && { opacity: 0.6 }]}>
              <Text style={styles.textBtnLabel}>프로젝트 편집</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.ProjectEdit, { projectId })} style={({ pressed }) => [styles.textBtn, pressed && { opacity: 0.6 }]}>
              <Text style={styles.textBtnLabel}>정보 수정</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      {editing && (
        <View style={[styles.bar, { paddingBottom: Math.max(spacing.md, insets.bottom + spacing.xs) }]}>
          <Text style={styles.barCount}>{picked.length}개 선택</Text>
          <View style={styles.barRow}>
            <Pressable accessibilityRole="button" onPress={exitEdit} style={styles.barBtn}><Text style={styles.barText}>취소</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={() => setPicked(picked.length === allKeys.length ? [] : allKeys)} style={styles.barBtn}>
              <Text style={styles.barText}>{picked.length === allKeys.length && allKeys.length > 0 ? '해제' : '전체'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={picked.length === 0 || otherProjects.length === 0} onPress={() => setMoving(true)} style={[styles.barBtn, (picked.length === 0 || otherProjects.length === 0) && styles.off]}>
              <Text style={styles.barText}>이동</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityHint={canUnlink ? undefined : '프로젝트 팀장과 공간 관리자만 연결을 해제할 수 있어요'} disabled={picked.length === 0 || !canUnlink} onPress={() => setConfirmUnlink(true)} style={[styles.barBtn, (picked.length === 0 || !canUnlink) && styles.off]}>
              <Text style={styles.barText}>연결 해제</Text>
            </Pressable>
          </View>
          {picked.length > 0 && !hasCloudPicked && <InlineDeletePrompt
            question={`선택한 ${picked.length}개를 삭제할까요?`}
            hint="메모는 휴지통으로 이동하고 할 일, 일정, 파일은 완전히 삭제됩니다."
            onDelete={deletePicked}
          />}
          {hasCloudPicked && <Text style={styles.itemSub}>클라우드 파일은 연결 해제로 프로젝트에서만 뺄 수 있어요.</Text>}
        </View>
      )}

      {/* 연결 추가 창 */}
      <Modal transparent visible={adding !== null} animationType="fade" onRequestClose={() => setAdding(null)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>{sections.find((s) => s.key === adding)?.label} 연결</Text>
            {adding === 'files' && (
              <>
                <DashedButton label={importingFiles ? (isSharedWorkspace ? '클라우드에 올리는 중…' : '가져오는 중…') : '기기에서 파일 가져오기'} onPress={importingFiles ? undefined : importPhoneFiles} style={[styles.linkBtn, importingFiles && styles.off]} />
                <Text style={styles.itemSub}>{isSharedWorkspace ? '가져오거나 연결한 파일은 클라우드에 저장되어 팀원과 공유돼요. 파일당 50MB까지 올릴 수 있어요.' : '고른 파일은 원본을 그대로 두고 이 프로젝트에 연결해요.'}</Text>
                {!!fileImportMessage && <Text accessibilityLiveRegion="polite" style={[styles.itemSub, { color: colors.coral }]}>{fileImportMessage}</Text>}
              </>
            )}
            <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: spacing.sm }}>
              {(sections.find((s) => s.key === adding)?.candidates || []).length === 0 && <Text style={styles.none}>연결할 수 있는 항목이 없어요</Text>}
              {(sections.find((s) => s.key === adding)?.candidates || []).length === 0 && adding !== null && adding !== 'files' && canCreateMemo && (
                <DashedButton label={`새 ${adding === 'memos' ? '메모' : adding === 'todos' ? '할 일' : '일정'} 만들기`} onPress={() => createForProject(adding)} style={styles.linkBtn} />
              )}
              {(sections.find((s) => s.key === adding)?.candidates || []).map((x) => {
                const on = addPicked.includes(x.id);
                const s = sections.find((q) => q.key === adding);
                const owner = projects.find((p) => p.id !== project.id && p.links[s.kind].includes(x.id));
                return (
                  <Pressable key={x.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={() => setAddPicked((a) => (a.includes(x.id) ? a.filter((i) => i !== x.id) : [...a, x.id]))} style={[styles.item, on && styles.itemOn]}>
                    <Icon name={on ? 'checkSquare' : 'square'} size={22} color={on ? colors.mintDark : colors.muted} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.itemTitle} numberOfLines={1}>{x.title}</Text>
                      <Text style={styles.itemSub} numberOfLines={1}>{x.sub}{owner ? `, 「${owner.title}」에서 이동` : ''}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.dialogRow}>
              <Pressable accessibilityRole="button" onPress={() => setAdding(null)} style={[styles.bigBtn, styles.ghost, { flex: 1 }]}><Text style={styles.ghostText}>취소</Text></Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={addPicked.length === 0}
                onPress={linkPicked}
                style={[styles.bigBtn, styles.primary, { flex: 1 }, addPicked.length === 0 && styles.off]}
              >
                <Text style={styles.primaryText}>연결 {addPicked.length || ''}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* 이동할 프로젝트 고르기 */}
      <Modal transparent visible={moving} animationType="fade" onRequestClose={() => setMoving(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>옮길 프로젝트</Text>
            <ScrollView style={{ maxHeight: 300 }} contentContainerStyle={{ gap: spacing.sm }}>
              {otherProjects.map((p) => (
                <Pressable
                  key={p.id}
                  accessibilityRole="button"
                  onPress={() => movePicked(p.id)}
                  style={styles.item}
                >
                  <Text style={styles.itemTitle}>{p.title}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable accessibilityRole="button" onPress={() => setMoving(false)} style={[styles.bigBtn, styles.ghost]}><Text style={styles.ghostText}>취소</Text></Pressable>
          </View>
        </View>
      </Modal>

      <ConfirmDialog
        visible={confirmUnlink}
        title={`선택한 ${picked.length}개의 연결을 해제할까요?`}
        sub="프로젝트에서만 빠지고, 메모, 할 일, 파일은 지워지지 않아요."
        confirmText="연결 해제"
        danger
        onCancel={() => setConfirmUnlink(false)}
        onConfirm={unlinkPicked}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  syncNotice: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  syncText: { flex: 1, fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  syncRetry: { minHeight: 44, justifyContent: 'center' },
  linkText: { fontSize: font.body, color: colors.mintDark },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  downloadBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  root: { flex: 1, backgroundColor: colors.cream },
  gone: { padding: spacing.xl, fontSize: font.bodyLg, color: colors.muted, textAlign: 'center' },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, gap: spacing.sm, paddingBottom: 140 },
  info: { gap: spacing.sm },
  infoRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  infoLine: { fontSize: 13, color: colors.muted },
  desc: { fontSize: font.body, color: colors.ink, lineHeight: 20 },
  heading: { fontSize: 12, color: colors.muted },
  viewHeader: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm },
  viewControls: { flexDirection: 'row', gap: spacing.sm },
  section: { gap: 4 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  sectionCount: { fontSize: 13, fontWeight: '400', color: colors.muted },
  sectionTitle: { fontSize: 14, color: colors.ink },
  flip: { transform: [{ rotate: '180deg' }] },
  none: { fontSize: 13, color: colors.muted, paddingVertical: 8 },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, borderColor: 'transparent', minHeight: 48 },
  itemOn: { borderColor: colors.actionBorder, backgroundColor: colors.card },
  itemTitle: { fontSize: 14, color: colors.ink },
  itemSub: { fontSize: font.caption, color: colors.muted },
  linkBtn: { minHeight: 44, borderRadius: radius.md },
  bottomRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.sm },
  bigBtn: { minHeight: 50, borderRadius: radius.card, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
  primary: { flex: 1, backgroundColor: colors.action },
  primaryText: { fontSize: font.bodyLg, fontWeight: '600', color: colors.onPrimary },
  ghost: { backgroundColor: colors.card, borderWidth: 0, borderColor: colors.line },
  ghostText: { fontSize: font.bodyLg, fontWeight: '500', color: colors.ink },
  off: { opacity: 0.4 },
  textBtn: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
  textBtnLabel: { fontSize: 14, color: colors.ink },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.cream, borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: 16, paddingTop: 6, paddingBottom: spacing.md, gap: 2 },
  barCount: { fontSize: 13, color: colors.muted, textAlign: 'center', paddingTop: 4 },
  barRow: { flexDirection: 'row', gap: 4 },
  barBtn: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  barText: { fontSize: 15, fontWeight: '500', color: colors.ink },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.card, padding: spacing.lg, gap: spacing.md },
  dialogTitle: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink },
  dialogRow: { flexDirection: 'row', gap: spacing.sm },
});
