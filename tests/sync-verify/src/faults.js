// 네트워크 장애 흉내: 서버 호출(SyncTransport)을 감싸서 끊김·응답 유실·스냅샷 요구를 만들어 냄
//   mode
//     'online'                 : 그대로 통과
//     'offline'                : 서버에 닿기 전에 실패 (비행기 모드)
//     'drop-response-once'     : 서버는 처리했는데 응답만 잃어버림 (한 번만)
//     'snapshot-required-once' : 다음 pull 한 번은 서버가 "전체 다시 받기"를 요구한 것처럼
function faulty(inner) {
  const w = {
    mode: 'online',
    lastReceipt: null,   // 마지막으로 서버가 돌려준 push 결과 (응답을 잃어버린 경우 포함)
    pulled: [],          // 지금까지 pull로 받은 변경 전부
    pushCalls: 0,
    async push(ws, operationId, ops, deviceId) {
      w.pushCalls++;
      if (w.mode === 'offline') throw new Error('Network request failed (검증용 끊김)');
      const r = await inner.push(ws, operationId, ops, deviceId);
      w.lastReceipt = r;
      if (w.mode === 'drop-response-once') {
        w.mode = 'online';
        throw new Error('Network request failed (검증용 응답 유실: 서버는 처리함)');
      }
      return r;
    },
    async pull(ws, afterSeq, limit) {
      if (w.mode === 'offline') throw new Error('Network request failed (검증용 끊김)');
      if (w.mode === 'snapshot-required-once') {
        w.mode = 'online';
        return { status: 'SNAPSHOT_REQUIRED', last_seq: afterSeq, min_retained_seq: afterSeq + 1, auth_epoch: 0 };
      }
      const r = await inner.pull(ws, afterSeq, limit);
      if (r.status === 'OK') w.pulled.push(...r.changes);
      return r;
    },
    async snapshot(ws) {
      if (w.mode === 'offline') throw new Error('Network request failed (검증용 끊김)');
      return inner.snapshot(ws);
    },
  };
  return w;
}

module.exports = { faulty };
