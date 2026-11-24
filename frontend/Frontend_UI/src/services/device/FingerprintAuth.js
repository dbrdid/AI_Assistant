import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

export async function supportsFingerprintOnly() {
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  const hasFingerprint = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
  return hasFingerprint && (Platform.OS === 'android' || types.length === 1);
}

export async function authenticateFingerprint(promptMessage, cancelLabel = '취소') {
  if (!(await supportsFingerprintOnly())) {
    return { success: false, error: 'fingerprint_only_unavailable' };
  }
  return LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel,
    disableDeviceFallback: true,
    fallbackLabel: '',
    ...(Platform.OS === 'android' ? { biometricsSecurityLevel: 'strong' } : {}),
  });
}
