import { Alert, Platform } from 'react-native';

// react-native-web's Alert.alert does nothing, so web uses the browser dialog instead.
export function alertUser(title, message = '') {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message || undefined);
}
