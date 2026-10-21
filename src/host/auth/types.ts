export interface AuthEndpoints {
  issuer?: string;
  discovery?: string;
  authorization?: string;
  token?: string;
  jwks?: string;
  revocation?: string;
  resource?: string;
}

export interface ResolvedEndpoints {
  issuer: string;
  authorization: string;
  token: string;
  jwks: string;
  revocation?: string;
  resource: string;
}

export interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  earliestRefreshAt?: string | number;
}

export interface PendingRefresh {
  credentials: StoredCredentials;
  scopes: string[];
  idToken: string;
  receivedAt: number;
}

export interface StoredProfile {
  id: string;
  label: string;
  clientId: string;
  subject?: string;
  email?: string;
  scopes: string[];
  state: "signed_out" | "signed_in" | "needs_login";
  credentials?: StoredCredentials;
  idToken?: string;
  pendingRefresh?: PendingRefresh;
  savedAt: string;
}

export interface PendingRegistration {
  id: string;
  label: string;
  clientId: string;
  savedAt: string;
}

export interface StoredAuthState {
  version: 1;
  hostId: string;
  activeProfileId?: string;
  profiles: StoredProfile[];
  pendingRegistrations: PendingRegistration[];
}

export interface VerifiedIdentity {
  subject: string;
  email?: string;
}
