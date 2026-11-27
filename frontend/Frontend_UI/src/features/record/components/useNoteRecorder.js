// AI 노트 녹음: 어느 탭에서든 하단 '새로 만들기 > AI 노트'로 그 자리에서 녹음한다.
// 녹음 중에는 하단 막대 자리에 녹음 막대(일시정지·끝내기)를 보이고, 끝나면 휴대폰 녹음 폴더에 저장한 뒤 정리 창을 띄운다.
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import RecordingBar from './RecordingBar';
import RecordSheet from './RecordSheet';
import { useRecorder } from '../../../services/device/Recorder';
import { addRecording } from '../../../data/files/FileStore';
import { addUsage } from '../../../data/settings/SettingsStore';
import { MAX_RECORDING_SECONDS } from '../../../lib/stella/recordings';
import { ROUTES } from '../../../navigation/routes';
import { colors } from '../../../shared/theme/theme';

export function useNoteRecorder(go, bottomInset = 0) {
  const rec = useRecorder();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [paused, setPaused] = useState(false);   // 일시정지 동안은 시간도 멈춤
  const [sheet, setSheet] = useState(null);      // { state, uri, seconds, fileId, folder, saveError }
  const busy = useRef(false);                    // 시작/종료 처리 중에 또 눌러도 무시
  useEffect(() => {
    if (!recording || paused) return undefined;
    const id = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording, paused]);

  const toggle = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (recording) {
        setRecording(false); setPaused(false);
        const uri = await rec.stop();
        if (!uri) return setSheet({ state: 'error' });
        // 저장하지 못해도 녹음 듣기와 변환은 그대로 됨. 실패 이유를 보여 주고 다시 저장할 수 있게 함
        let saved = null, saveError = '';
        try { saved = await addRecording(uri, seconds); }
        catch (error) { saveError = error?.message || '녹음 파일을 저장하지 못했어요.'; }
        addUsage('voice', Math.max(1, Math.ceil(seconds / 60))); // 녹음 이용량은 분 단위
        setSheet({ state: saved ? 'saved' : 'save_error', uri: saved?.uri || uri, seconds, fileId: saved?.id ?? null, folder: saved?.recordingFolder, saveError });
      } else {
        const r = await rec.start();
        if (!r.ok) return setSheet({ state: r.reason === 'denied' ? 'denied' : 'error' });
        setSeconds(0); setRecording(true);
      }
    } finally { busy.current = false; }
  };
  // 서버가 받는 최대 길이(3시간)가 되면 녹음을 끝내고 정리 창을 띄움
  const toggleRef = useRef(toggle); toggleRef.current = toggle;
  useEffect(() => { if (recording && seconds >= MAX_RECORDING_SECONDS) void toggleRef.current(); }, [recording, seconds]);

  const retrySave = async () => {
    const current = sheet;
    if (current?.state !== 'save_error' || current.saving) return;
    setSheet({ ...current, saving: true, saveError: '' });
    try {
      const saved = await addRecording(current.uri, current.seconds);
      setSheet({ ...current, state: 'saved', uri: saved.uri || current.uri, fileId: saved.id, folder: saved.recordingFolder, saving: false, saveError: '' });
    } catch (error) {
      setSheet({ ...current, saving: false, saveError: error?.message || '녹음 파일을 저장하지 못했어요.' });
    }
  };

  const close = () => setSheet(null);
  return {
    recording,
    start: () => { if (!recording) void toggle(); },
    bar: recording && <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 16, paddingTop: 6, paddingBottom: Math.max(10, bottomInset), borderTopWidth: 1, borderTopColor: colors.line }}>
      <RecordingBar recorder={rec.recorder} seconds={seconds} paused={paused}
        onPause={() => rec.pause() && setPaused(true)} onResume={() => rec.resume() && setPaused(false)} onStop={toggle} />
    </View>,
    sheet: <RecordSheet sheet={sheet} onClose={close}
      onOpenFiles={() => { close(); go(ROUTES.Files); }}
      onOpenMemo={memoId => { close(); go(ROUTES.MemoEdit, { memoId }); }}
      onOpenProposals={() => { close(); go(ROUTES.Proposals); }}
      onRetrySave={retrySave} />,
  };
}
