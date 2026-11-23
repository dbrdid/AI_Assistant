export function selectChatSources({ attachments, records, fileVaultOnly }) {
  if (!fileVaultOnly) return { attachments, records };
  return {
    attachments: attachments.filter((source) => source.sourceScope === 'vault'),
    records: [],
  };
}
