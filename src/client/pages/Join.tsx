import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { post, useApi } from '../api.ts';
import { ErrorBox, Spinner } from '../components/ui.tsx';
import { useSession } from '../session.ts';
import { AuthPage } from './Auth.tsx';

interface InvitePreview {
  group: { name: string; emoji: string; memberCount: number };
  alreadyMember: boolean;
  groupId: number | null;
}

export function JoinPage({ code }: { code: string }) {
  const { user } = useSession();
  // Refetch after login so `alreadyMember` reflects the new session.
  const preview = useApi<InvitePreview>(`/invites/${encodeURIComponent(code)}?u=${user?.id ?? 0}`);
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);

  if (preview.error) {
    return (
      <div className="stack narrow">
        <ErrorBox message={preview.error} />
        <Link href="/" className="btn">
          Ir al inicio
        </Link>
      </div>
    );
  }
  if (!preview.data) return <Spinner />;
  const { group, alreadyMember, groupId } = preview.data;

  if (!user) {
    return <AuthPage inviteCode={code} title={`Te invitaron a ${group.emoji} ${group.name}. Crea tu cuenta (o entra) para unirte.`} />;
  }

  const join = async () => {
    try {
      const r = await post<{ groupId: number }>(`/invites/${encodeURIComponent(code)}/join`);
      navigate(`/groups/${r.groupId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card stack narrow center-text">
      <div className="big-emoji">{group.emoji}</div>
      <h1>{group.name}</h1>
      <p className="muted">{group.memberCount} miembros</p>
      {alreadyMember && groupId ? (
        <Link href={`/groups/${groupId}`} className="btn btn-primary">
          Ya eres parte, ir al grupo
        </Link>
      ) : (
        <button className="btn btn-primary" onClick={join}>
          Unirme al grupo
        </button>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
