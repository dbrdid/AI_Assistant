// 홈 위쪽 오른쪽의 알림(종) 버튼 — Figma 시안의 동그란 흰 버튼 + 안 읽은 알림이 있으면 코랄 점
import React from 'react';
import { CircleButton } from '../../../shared/components/Ui';
import { useNotices } from '../../../data/notices/NoticeStore';

export default function Bell({ onPress }) {
  const unread = useNotices().filter((n) => !n.read).length;
  return <CircleButton icon="bell" label={unread ? `알림 ${unread}개 안 읽음` : '알림'} onPress={onPress} badge={unread > 0} />;
}
