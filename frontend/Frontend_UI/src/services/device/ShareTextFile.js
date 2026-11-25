import { Platform } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { isAvailableAsync, shareAsync } from 'expo-sharing';

/** 글자 파일 하나를 공유 시트로 내보냄 (웹은 내려받기). mimeType과 UTI는 파일 형식에 맞게 */
export async function shareTextFile({ name, content, mimeType, uti }) {
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
  await shareAsync(file.uri, { mimeType, UTI: uti, dialogTitle: '메모 내보내기' });
}

export const shareMarkdownFile = ({ name, content }) => shareTextFile({ name, content, mimeType: 'text/markdown', uti: 'net.daringfireball.markdown' });
export const shareHtmlFile = ({ name, content }) => shareTextFile({ name, content, mimeType: 'text/html', uti: 'public.html' });
export const shareJsonFile = ({ name, content }) => shareTextFile({ name, content, mimeType: 'application/json', uti: 'public.json' });
