import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

// 사이드 메뉴 열림/닫힘 상태만 공유한다.
const MenuContext = createContext(null);

export function MenuProvider({ children }) {
  const [visible, setVisible] = useState(false);
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);
  const value = useMemo(() => ({ visible, open, close }), [visible, open, close]);
  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>;
}

export function useMenu() {
  const ctx = useContext(MenuContext);
  if (!ctx) throw new Error('MenuProvider 안에서 사용하세요');
  return ctx;
}
