import { File, Paths } from 'expo-file-system';
import { createRecorder } from './s22Metrics.mjs';

// One file per process, so an app restart during a run cannot overwrite earlier results.
const file = new File(Paths.document, 's22-metrics-' + Date.now() + '.json');
export const recorder = createRecorder(text => {
  if (!file.exists) file.create();
  file.write(text);
});
