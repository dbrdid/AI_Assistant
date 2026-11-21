import { Alert, Platform } from 'react-native';

// react-native-web의 Alert.alert는 동작하지 않으므로 웹에서는 브라우저 대화 상자를 사용합니다.
export function alertUser(title, message = '') {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message || undefined);
}
