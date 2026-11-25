import React, { useEffect, useState } from 'react';
import { Image, Platform } from 'react-native';
import { releaseDeviceAccess, resolveDeviceReference } from '../../../../modules/device-file-access';

export default function AccessibleFileImage({ file, ...imageProps }) {
  const [uri, setUri] = useState('');
  const [failed, setFailed] = useState(false);
  const reference = file?.fileReference ?? file?.saveDirectoryReference;
  const isFileReference = !!file?.fileReference;

  useEffect(() => {
    let active = true;
    let accessToken = '';
    setFailed(false);
    setUri(Platform.OS === 'web' || !reference ? file?.uri ?? '' : '');
    if (Platform.OS === 'web' || !reference) return () => { active = false; };

    resolveDeviceReference(reference).then(access => {
      if (!active) {
        if (access.token) void releaseDeviceAccess(access.token).catch(error => console.warn('[files] 이미지 접근 권한을 해제하지 못했습니다.', error));
        return;
      }
      accessToken = access.token;
      setUri(isFileReference ? access.uri : file.uri);
    }).catch(error => {
      if (active) {
        setFailed(true);
        console.warn('[files] 기기 파일 이미지에 접근하지 못했습니다.', file?.name, error);
      }
    });

    return () => {
      active = false;
      if (accessToken) void releaseDeviceAccess(accessToken).catch(error => console.warn('[files] 이미지 접근 권한을 해제하지 못했습니다.', error));
    };
  }, [file?.id, file?.name, file?.uri, isFileReference, reference]);

  if (!uri || failed) return null;
  return <Image {...imageProps} source={{ uri }} onError={() => setFailed(true)} />;
}
