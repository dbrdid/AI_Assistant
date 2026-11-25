// 입력 커서, 선택 핸들, 스위치 등 안드로이드 기본 강조색(청록)을 앱의 무채색 강조색으로 맞춘다.
// 값은 shared/theme/theme.js 의 palette.accent 와 같다.
const { withAndroidStyles } = require('expo/config-plugins');

const ACCENT = '#d9d9d6';

module.exports = config => withAndroidStyles(config, next => {
  const theme = next.modResults.resources.style?.find(s => s.$.name === 'AppTheme');
  if (theme) {
    theme.item = (theme.item ?? []).filter(i => !['colorAccent', 'colorControlActivated'].includes(i.$.name));
    theme.item.push({ $: { name: 'colorAccent' }, _: ACCENT }, { $: { name: 'colorControlActivated' }, _: ACCENT });
  }
  return next;
});
