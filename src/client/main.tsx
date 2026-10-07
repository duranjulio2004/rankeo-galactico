import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Route, Switch, Link, useLocation } from 'wouter';
import { get, post, type User } from './api.ts';
import { Spinner, ToastHost } from './components/ui.tsx';
import { AuthPage } from './pages/Auth.tsx';
import { HomePage } from './pages/Home.tsx';
import { NewListPage } from './pages/NewList.tsx';
import { ListPage } from './pages/List.tsx';
import { GroupPage } from './pages/Group.tsx';
import { JoinPage } from './pages/Join.tsx';
import { SessionContext } from './session.ts';
import './styles.css';


function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [location] = useLocation();

  useEffect(() => {
    get<{ user: User }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
    const onUnauthorized = () => setUser(null);
    window.addEventListener('rg:unauthorized', onUnauthorized);
    return () => window.removeEventListener('rg:unauthorized', onUnauthorized);
  }, []);

  if (user === undefined) {
    return (
      <div className="center-screen">
        <Spinner />
      </div>
    );
  }

  // The join page handles its own logged-out state (sign up + join in one go).
  const isJoin = location.startsWith('/join/');
  return (
    <SessionContext.Provider value={{ user, setUser }}>
      {user && <TopBar user={user} onLogout={() => setUser(null)} />}
      <main className="page">
        {!user && !isJoin ? (
          <AuthPage />
        ) : (
          <Switch>
            <Route path="/" component={HomePage} />
            <Route path="/new" component={NewListPage} />
            <Route path="/lists/:id/:tab?">{(p) => <ListPage id={Number(p.id)} tab={p.tab ?? 'duelo'} />}</Route>
            <Route path="/groups/:id">{(p) => <GroupPage id={Number(p.id)} />}</Route>
            <Route path="/join/:code">{(p) => <JoinPage code={p.code} />}</Route>
            <Route>
              <div className="empty">
                <h3>Esta página se fue a un agujero negro</h3>
                <Link href="/" className="btn">
                  Volver al inicio
                </Link>
              </div>
            </Route>
          </Switch>
        )}
      </main>
      <ToastHost />
    </SessionContext.Provider>
  );
}

function TopBar({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [, navigate] = useLocation();
  const logout = async () => {
    await post('/auth/logout').catch(() => {});
    onLogout();
    navigate('/');
  };
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <span className="brand-planet">🪐</span>
        <span className="brand-name">
          Rankeo <em>Galáctico</em>
        </span>
      </Link>
      <div className="topbar-user">
        <span className="muted hide-sm">{user.displayName}</span>
        <button className="btn btn-ghost btn-sm" onClick={logout}>
          Salir
        </button>
      </div>
    </header>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
