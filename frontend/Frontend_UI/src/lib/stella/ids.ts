// UUID 생성: 기록 id, sync operation_id, AI client_request_id 모두 앱이 만듭니다.
import { randomUUID } from 'expo-crypto';

export const newId = (): string => randomUUID();
