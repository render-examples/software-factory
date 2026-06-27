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

export interface OAuthStore {
  getConnection(userId: string, provider: string): Promise<OAuthConnection | undefined>;
  upsertConnection(conn: OAuthConnection): Promise<void>;
  deleteConnection(userId: string, provider: string): Promise<void>;
  listConnections(userId: string): Promise<OAuthConnection[]>;
}
