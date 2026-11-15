import { useValue, list } from '../hooks';
export const MAX_BACKUPS = 10;
export const useBackups = () => useValue(() => list('backup-metadata'));
// Never claim a backup succeeded until local file content and cloud restore are accepted together.
export const createBackup = async () => ({ ok: false, reason: 'integration-pending' });
export const restoreBackup = async () => ({ ok: false, reason: 'integration-pending' });
export const deleteBackup = async () => ({ ok: false, reason: 'integration-pending' });
