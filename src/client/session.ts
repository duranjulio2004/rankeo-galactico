import { createContext, useContext } from 'react';
import type { User } from './api.ts';

export interface Session {
  user: User | null;
  setUser: (u: User | null) => void;
}

export const SessionContext = createContext<Session>({ user: null, setUser: () => {} });
export const useSession = () => useContext(SessionContext);
