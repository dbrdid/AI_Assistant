// expo-sqlite → SqlDb (local-sync.ts가 쓰는 모양)
//   import * as SQLite from 'expo-sqlite';
//   const db = expoSqliteDb(await SQLite.openDatabaseAsync('stella.db'));
//   await setupLocalSync(db);
import type { SqlDb, SqlValue } from './local-sync';

/** expo-sqlite SQLiteDatabase에서 쓰는 메서드만 (패키지 타입에 직접 의존하지 않으려고 구조만 적음) */
export interface ExpoSQLiteDatabaseLike {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SqlValue[]): Promise<unknown>;
  getAllAsync<T>(source: string, params: SqlValue[]): Promise<T[]>;
  getFirstAsync<T>(source: string, params: SqlValue[]): Promise<T | null>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export function expoSqliteDb(db: ExpoSQLiteDatabaseLike): SqlDb {
  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params = []) => { await db.runAsync(sql, params); },
    all: <T>(sql: string, params: SqlValue[] = []) => db.getAllAsync<T>(sql, params),
    get: async <T>(sql: string, params: SqlValue[] = []) => (await db.getFirstAsync<T>(sql, params)) ?? undefined,
    transaction: async <T>(fn: () => Promise<T>) => {
      let out: T | undefined;
      await db.withTransactionAsync(async () => { out = await fn(); });
      return out as T;
    },
  };
}
