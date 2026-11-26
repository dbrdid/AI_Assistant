// The scoped file callback must stay open until the native player releases the source.
export function createRecordingPlayback(withSource, createPlayer, update) {
  let current = null;

  function stop() {
    const session = current;
    current = null;
    if (!session) return;
    try {
      session.subscription?.remove();
    } finally {
      try { session.player?.release(); }
      finally { session.done?.(); }
    }
  }

  function fail(session, error) {
    if (current !== session) return;
    stop();
    update({ state: 'error', message: error?.message || '녹음 파일을 열 수 없어요.' });
  }

  async function toggle() {
    if (current) {
      const session = current;
      if (!session.player) return;
      try {
        if (session.player.playing) session.player.pause();
        else session.player.play();
      } catch (error) { fail(session, error); }
      return;
    }

    const session = {};
    current = session;
    update({ state: 'loading' });
    try {
      await withSource(async uri => {
        if (current !== session) return;
        try {
          const ended = new Promise(resolve => { session.done = resolve; });
          const player = createPlayer(uri);
          session.player = player;
          session.subscription = player.addListener('playbackStatusUpdate', status => {
            if (current !== session) return;
            if (status.error) { fail(session, new Error(status.error)); return; }
            const duration = status.duration;
            if (status.didJustFinish) {
              stop();
              update({ state: 'finished', position: duration, duration });
            } else {
              update({ state: status.playing ? 'playing' : status.isLoaded ? 'paused' : 'loading', position: status.currentTime, duration });
            }
          });
          player.play();
          await ended;
        } catch (error) { fail(session, error); }
      });
    } catch (error) { fail(session, error); }
  }

  return { toggle, stop };
}

export function formatRecordingTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds > 0 && seconds < 1) return `${Number(seconds.toFixed(3)) || '<0.001'}초`;
  const whole = Math.floor(seconds);
  const minutes = String(Math.floor(whole / 60)).padStart(2, '0');
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}
