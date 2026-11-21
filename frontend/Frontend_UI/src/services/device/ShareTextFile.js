import { Platform } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { isAvailableAsync, shareAsync } from 'expo-sharing';

export async function shareMarkdownFile({ name, content }) {
  const mimeType = 'text/markdown';
  if (Platform.OS === 'web') {
    const href = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
    const link = document.createElement('a');
    link.href = href;
    link.download = name;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    }
    return;
  }
  if (!(await isAvailableAsync())) throw new Error('이 기기에서는 파일 공유를 사용할 수 없어요.');
  const folder = new Directory(Paths.cache, randomUUID());
  folder.create();
  const file = new File(folder, name);
  file.create();
  await file.write(content);
  await shareAsync(file.uri, { mimeType, UTI: 'net.daringfireball.markdown', dialogTitle: '메모 내보내기' });
}
