import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type Connection,
  type Institution,
  type OAuthGrant,
} from './api';
import { Banner, ConfirmModal, EmptyState, type ConfirmState } from './components';
import { SHARING_COPY as copy } from './sharing-copy';

// `read:data` is the only permission the API can grant — it reads, and does nothing else.
const OAUTH_SCOPE_LABELS: Readonly<Record<string, string>> = {
  'read:data': copy.readDataPermission,
};

interface ActiveAccess {
  id: string;
  name: string;
  connectionGrants: string[];
  permissions: string[];
  createdAt: string;
  expiresAt: string;
}

function connectionLabel(
  connection: Connection,
  institutions: ReadonlyMap<string, Institution>,
): string {
  const institutionName =
    institutions.get(connection.institutionId)?.name ?? connection.institutionId;
  return connection.nickname
    ? `${institutionName} · ${connection.nickname}`
    : institutionName;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString('en-GB', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
}

function oauthAccess(grant: OAuthGrant): ActiveAccess | null {
  if (grant.status !== 'active') return null;
  return {
    id: grant.id,
    name: grant.clientName ?? copy.unknownOrganisation,
    connectionGrants: grant.connectionGrants,
    permissions: grant.scopes.map((scope) => OAUTH_SCOPE_LABELS[scope] ?? scope),
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
  };
}

export function Sharing() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [grants, setGrants] = useState<OAuthGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [connectionResult, institutionResult, grantResult] =
        await Promise.all([
          api.listConnections(),
          api.listInstitutions(),
          api.listOAuthGrants(),
        ]);
      setConnections(connectionResult.connections);
      setInstitutions(institutionResult.institutions);
      setGrants(grantResult.grants);
      setError(null);
    } catch {
      setError(copy.loadError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connectionById = useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection])),
    [connections],
  );
  const institutionById = useMemo(
    () => new Map(institutions.map((institution) => [institution.id, institution])),
    [institutions],
  );
  const activeAccess = useMemo(
    () => grants
      .map(oauthAccess)
      .filter((grant): grant is ActiveAccess => !!grant)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [grants],
  );

  function reviewRevoke(access: ActiveAccess): void {
    setConfirm({
      title: copy.revokeHeading(access.name),
      body: <p>{copy.revokeBody(access.name)}</p>,
      confirmLabel: copy.confirmRevoke,
      danger: true,
      onConfirm: async () => {
        setError(null);
        setSuccess(null);
        try {
          await api.revokeOAuthGrant(access.id);
          setSuccess(copy.revokeSuccess(access.name));
          await load();
        } catch {
          setError(copy.revokeError);
        }
      },
    });
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{copy.heading}</h1>
          <p className="page-sub">{copy.intro}</p>
        </div>
      </div>
      {error && <Banner tone="err" onClose={() => setError(null)}>{error}</Banner>}
      {success && <Banner tone="ok" onClose={() => setSuccess(null)}>{success}</Banner>}

      <section className="panel">
        <h3>{copy.activeHeading}</h3>
        {!loading && activeAccess.length === 0 ? (
          <EmptyState title={copy.noAccessHeading} hint={copy.noAccessBody} />
        ) : (
          <div className="share-list">
            {activeAccess.map((access) => (
              <article className="share-card" key={access.id}>
                <div className="share-card-head">
                  <div>
                    <div className="row-title">{access.name}</div>
                    <span className="badge badge-ok">{copy.statusActive}</span>
                  </div>
                  <button
                    className="danger small"
                    onClick={() => reviewRevoke(access)}
                  >
                    {copy.revoke}
                  </button>
                </div>
                <dl className="share-details">
                  <div>
                    <dt>{copy.sharedConnections}</dt>
                    <dd>
                      {access.connectionGrants.map((id) => {
                        const connection = connectionById.get(id);
                        return connection
                          ? connectionLabel(connection, institutionById)
                          : id;
                      }).join(', ')}
                    </dd>
                  </div>
                  <div>
                    <dt>{copy.permissions}</dt>
                    <dd>{access.permissions.join(', ')}</dd>
                  </div>
                  <div>
                    <dt>{copy.accessGranted}</dt>
                    <dd>{formatDate(access.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>{copy.accessEnds}</dt>
                    <dd>{formatDate(access.expiresAt)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>

      <ConfirmModal state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
