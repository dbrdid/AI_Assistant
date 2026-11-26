import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

export type DeviceFileReference = {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
  reference: string;
};

export type ResolvedDeviceReference = {
  uri: string;
  token: string;
  reference: string;
};

type DeviceFileAccessNative = {
  pickFiles(multiple: boolean): Promise<DeviceFileReference[]>;
  pickDirectory(initialUri?: string): Promise<DeviceFileReference>;
  resolveReference(reference: string): Promise<ResolvedDeviceReference>;
  releaseAccess(token: string): Promise<void>;
  releaseReference(reference: string): Promise<void>;
  saveToRecordings(sourceUri: string, name: string, mimeType: string): Promise<{ uri: string; size: number; folder: string }>;
  deleteContent(uri: string): Promise<boolean>;
};

function nativeModule() {
  if (Platform.OS === 'web') throw new Error('기기 파일 접근은 모바일 앱에서만 사용할 수 있어요.');
  try {
    return requireNativeModule<DeviceFileAccessNative>('DeviceFileAccess');
  } catch (error) {
    throw Object.assign(
      new Error('원본 파일을 복사하지 않고 연결하려면 최신 앱 버전을 설치해 주세요.'),
      { cause: error },
    );
  }
}

/** 녹음을 휴대폰 녹음 폴더(Recordings/Atria)에 저장. Android 전용 */
export const saveToRecordings = (sourceUri: string, name: string, mimeType = 'audio/mp4'): Promise<{ uri: string; size: number; folder: string }> =>
  nativeModule().saveToRecordings(sourceUri, name, mimeType);
export const deleteDeviceContent = (uri: string): Promise<boolean> => nativeModule().deleteContent(uri);
export const pickDeviceFiles = (multiple = true) => nativeModule().pickFiles(multiple);
export const pickDeviceDirectory = (initialUri?: string) => nativeModule().pickDirectory(initialUri);
export const resolveDeviceReference = (reference: string) => nativeModule().resolveReference(reference);
export const releaseDeviceAccess = (token: string) => nativeModule().releaseAccess(token);
export const releaseDeviceReference = (reference: string) => nativeModule().releaseReference(reference);
