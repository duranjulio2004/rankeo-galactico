import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Route, Switch, Link, useLocation } from 'wouter';
import { get, type User } from './api.ts';
import { Spinner, ToastHost } from './components/ui.tsx';
import { AccessPage, AuthPage } from './pages/Auth.tsx';
import { AdminPage } from './pages/Admin.tsx';
import { MePage } from './pages/Me.tsx';
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

  // Join and access-link pages handle their own logged-out state.
  const isPublic = location.startsWith('/join/') || location.startsWith('/acceso/');
  return (
    <SessionContext.Provider value={{ user, setUser }}>
      {user && <TopBar user={user} />}
      <main className="page">
        {!user && !isPublic ? (
          <AuthPage />
        ) : (
          <Switch>
            <Route path="/" component={HomePage} />
            <Route path="/new" component={NewListPage} />
            <Route path="/lists/:id/:tab?">{(p) => <ListPage id={Number(p.id)} tab={p.tab ?? 'duelo'} />}</Route>
            <Route path="/groups/:id">{(p) => <GroupPage id={Number(p.id)} />}</Route>
            <Route path="/join/:code">{(p) => <JoinPage code={p.code} />}</Route>
            <Route path="/acceso/:key">{(p) => <AccessPage accessKey={p.key} />}</Route>
            <Route path="/yo" component={MePage} />
            <Route path="/admin" component={AdminPage} />
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

function TopBar({ user }: { user: User }) {
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <span className="brand-planet">🪐</span>
        <span className="brand-name">
          Rankeo <em>Galáctico</em>
        </span>
      </Link>
      <nav className="topbar-user">
        {user.isAdmin && (
          <Link href="/admin" className="btn btn-ghost btn-sm">
            Admin
          </Link>
        )}
        <Link href="/yo" className="btn btn-ghost btn-sm" title="Tu nombre y link de acceso">
          {user.displayName}
        </Link>
      </nav>
    </header>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
