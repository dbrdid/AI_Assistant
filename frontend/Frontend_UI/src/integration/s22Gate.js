// Metro replaces __DEV__ with false in release and drops this require, so the recorder is not bundled.
export const metrics = typeof __DEV__ !== 'undefined' && __DEV__ ? require('./s22Metrics.dev').recorder : null;
