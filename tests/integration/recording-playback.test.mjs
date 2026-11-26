import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordingPlayback, formatRecordingTime } from '../../frontend/Frontend_UI/src/features/record/components/recordingPlayback.mjs';

test('pause and resume use one player, completion releases the player before the file and replay starts fresh', async () => {
  const events = [], sources = [], updates = [];
  function makePlayer(uri) {
    const player = {
      playing: false,
      addListener(_, cb) { this.status = cb; return { remove() { events.push('unlisten'); } }; },
      play() { this.playing = true; events.push('play'); },
      pause() { this.playing = false; events.push('pause'); },
      release() { events.push('release'); },
    };
    sources.push({ player, uri });
    return player;
  }
  const playback = createRecordingPlayback(async use => {
    events.push('open'); try { await use('content://local-recording'); } finally { events.push('close'); }
  }, makePlayer, status => updates.push(status));
  const first = playback.toggle();
  await playback.toggle();
  await playback.toggle();
  sources[0].player.status({ didJustFinish: true, duration: 13.6 });
  await first;
  assert.deepEqual(events, ['open', 'play', 'pause', 'play', 'unlisten', 'release', 'close']);
  assert.deepEqual(updates.at(-1), { state: 'finished', position: 13.6, duration: 13.6 });
  const replay = playback.toggle();
  assert.equal(sources.length, 2);
  assert.equal(sources[1].uri, 'content://local-recording');
  playback.stop();
  await replay;
  // A late event from the old native player must not update or stop a replacement.
  sources[0].player.status({ error: 'stale event' });
  assert.equal(updates.at(-1).state, 'loading');
});

test('closing the preview before file permission resolves never starts playback', async () => {
  let releaseAccess, closed = false;
  const gate = new Promise(resolve => { releaseAccess = resolve; });
  const playback = createRecordingPlayback(async use => {
    await gate; try { await use('content://old'); } finally { closed = true; }
  }, () => { assert.fail('stale file was opened'); }, () => {});
  const pending = playback.toggle();
  playback.stop();
  releaseAccess();
  await pending;
  assert.ok(closed);
});

test('decoder errors are visible and release the file, retry opens a fresh source', async () => {
  const states = [];
  let listener, closed = 0, released = 0;
  const playback = createRecordingPlayback(async use => {
    try { await use('file://bad'); } finally { closed++; }
  }, () => ({
    addListener(_, cb) { listener = cb; return { remove() {} }; },
    release() { released++; }, play() {},
  }), status => states.push(status));
  for (let i = 0; i < 2; i++) {
    const run = playback.toggle();
    listener({ error: 'Unsupported audio' });
    await run;
    assert.equal(released, i + 1);
    assert.equal(closed, i + 1);
    assert.deepEqual(states.at(-1), { state: 'error', message: 'Unsupported audio' });
  }
});

test('recording times keep real subsecond recordings visible and format complete seconds', () => {
  assert.equal(formatRecordingTime(0.022), '0.022초');
  assert.equal(formatRecordingTime(0.1), '0.1초');
  assert.equal(formatRecordingTime(61.25), '01:01');
  assert.equal(formatRecordingTime(0), '00:00');
  assert.equal(formatRecordingTime(null), '—');
});
