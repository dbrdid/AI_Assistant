import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent는 AppRegistry.registerComponent('main', () => App)를 호출합니다.
// 또한 Expo Go에서 앱을 실행하든 네이티브 빌드에서 실행하든
// 환경이 올바르게 설정되도록 합니다.
registerRootComponent(App);
