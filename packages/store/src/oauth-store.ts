export interface OAuthConnection {
  id: string;
  userId: string;
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

/** Freshly-exchanged token material returned by a provider refresh. */
export interface RefreshedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface OAuthStore {
  getConnection(userId: string, provider: string): Promise<OAuthConnection | undefined>;
  upsertConnection(conn: OAuthConnection): Promise<void>;
  deleteConnection(userId: string, provider: string): Promise<void>;
  listConnections(userId: string): Promise<OAuthConnection[]>;
  /**
   * Single-flight token refresh. Acquires an exclusive lock on the connection
   * (Postgres `SELECT ... FOR UPDATE`; an in-process mutex for memory),
   * re-checks freshness under the lock, and only then invokes `doRefresh` so
   * concurrent callers coalesce into one provider refresh (the documented
   * token-refresh race). Returns the current/refreshed connection.
   */
  refreshConnection(
    userId: string,
    provider: string,
    isExpired: (conn: OAuthConnection) => boolean,
    doRefresh: (conn: OAuthConnection) => Promise<RefreshedTokens>,
  ): Promise<OAuthConnection | undefined>;
}
