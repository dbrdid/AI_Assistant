// ============================================================
// ErrorBoundary.js — 화면을 그리다 예기치 못한 오류가 나도 앱이 하얗게 멈추지 않도록 감싸는 부품
// ============================================================

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../../../shared/theme/theme';
import { ServerErrorView } from './ErrorViews';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, round: 0, detail: '' };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    const where = String((info && info.componentStack) || '').split('\n').filter(Boolean).slice(0, 4).map((l) => l.trim()).join(' < ');
    this.setState({ detail: `${String((error && error.message) || error || '').slice(0, 200)}${where ? `\n위치: ${where}` : ''}`.slice(0, 500) });
    // TODO(백엔드 연결 후): 오류 기록을 서버로 보내 두면 원인 파악에 도움이 돼요.
    if (typeof console !== 'undefined') console.warn('앱 오류:', error && error.message, '\n', error && error.stack ? String(error.stack).split('\n').slice(0, 8).join('\n') : '', '\n', info && info.componentStack ? String(info.componentStack).split('\n').slice(0, 8).join('\n') : '');
  }

  render() {
    if (this.state.failed) {
      return (
        <View style={styles.root}>
          <ServerErrorView
            title="문제가 발생했어요"
            message={'예기치 못한 오류가 발생했어요.\n저장된 메모와 일정은 그대로 남아 있어요.'}
            onHome={() => this.setState((s) => ({ failed: false, round: s.round + 1, detail: '' }))}
          />
          {!!this.state.detail && <Text style={styles.detail} selectable>오류 내용: {this.state.detail}</Text>}
        </View>
      );
    }
    // round 가 바뀌면 자식을 새로 만들어서 홈부터 다시 시작
    return <React.Fragment key={this.state.round}>{this.props.children}</React.Fragment>;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  detail: { marginTop: spacing.lg, fontSize: 12, color: colors.muted, textAlign: 'center' },
});
