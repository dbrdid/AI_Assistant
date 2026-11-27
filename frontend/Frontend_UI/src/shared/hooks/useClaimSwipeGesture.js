import { createContext, useContext } from 'react';

export const SwipeGestureContext = createContext(() => {});

export function useClaimSwipeGesture() {
  return useContext(SwipeGestureContext);
}
