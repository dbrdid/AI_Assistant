// 테스트용 AsyncStorage 대역 (메모리)
const mem = new Map<string, string>();
const AsyncStorage = {
  getItem: async (k: string) => mem.get(k) ?? null,
  setItem: async (k: string, v: string) => { mem.set(k, v); },
  removeItem: async (k: string) => { mem.delete(k); },
  clear: async () => { mem.clear(); },
};
export default AsyncStorage;
