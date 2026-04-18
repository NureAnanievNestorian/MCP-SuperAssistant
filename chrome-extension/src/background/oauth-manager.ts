import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { createLogger } from '@extension/shared/lib/logger';
import type { TransportType } from '../mcpclient/types/plugin.js';

const logger = createLogger('OAuthManager');

const OAUTH_SESSIONS_KEY = 'mcpOAuthSessions';

export interface OAuthConfig {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  clientName?: string;
  clientMetadataUrl?: string;
}

interface StoredOAuthSession {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  updatedAt: number;
}

type SessionStore = Record<string, StoredOAuthSession>;

type InteractiveOAuthProvider = OAuthClientProvider & {
  waitForAuthorizationCode?: () => Promise<string>;
  isAuthorizing?: () => boolean;
  clearSessionData?: () => Promise<void>;
};

function encodeSessionKey(serverUrl: string): string {
  return `srv:${encodeURIComponent(serverUrl)}`;
}

async function loadSessions(): Promise<SessionStore> {
  const result = await chrome.storage.local.get([OAUTH_SESSIONS_KEY]);
  return (result[OAUTH_SESSIONS_KEY] as SessionStore | undefined) ?? {};
}

async function saveSessions(sessions: SessionStore): Promise<void> {
  await chrome.storage.local.set({ [OAUTH_SESSIONS_KEY]: sessions });
}

function randomState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

class ChromeOAuthProvider implements InteractiveOAuthProvider {
  public clientMetadataUrl?: string;

  private readonly sessionKey: string;
  private pendingAuthPromise: Promise<string> | null = null;

  constructor(
    private readonly serverUrl: string,
    private config: OAuthConfig,
    private readonly consumeInteractivePermission: () => boolean,
  ) {
    this.sessionKey = encodeSessionKey(serverUrl);
    this.clientMetadataUrl = config.clientMetadataUrl;
  }

  updateConfig(config: OAuthConfig): void {
    this.config = config;
    this.clientMetadataUrl = config.clientMetadataUrl;
  }

  get redirectUrl(): string {
    return chrome.identity.getRedirectURL('mcp-oauth');
  }

  get clientMetadata(): OAuthClientMetadata {
    const hasSecret = !!this.config.clientSecret;
    return {
      client_name: this.config.clientName || 'MCP SuperAssistant',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: hasSecret ? 'client_secret_post' : 'none',
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }

  state(): string {
    return randomState();
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
      };
    }

    const sessions = await loadSessions();
    return sessions[this.sessionKey]?.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    const sessions = await loadSessions();
    const prev = sessions[this.sessionKey] ?? { updatedAt: Date.now() };
    sessions[this.sessionKey] = {
      ...prev,
      clientInformation,
      updatedAt: Date.now(),
    };
    await saveSessions(sessions);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const sessions = await loadSessions();
    return sessions[this.sessionKey]?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const sessions = await loadSessions();
    const prev = sessions[this.sessionKey] ?? { updatedAt: Date.now() };
    sessions[this.sessionKey] = {
      ...prev,
      tokens,
      updatedAt: Date.now(),
    };
    await saveSessions(sessions);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.pendingAuthPromise) {
      const interactive = this.consumeInteractivePermission();
      if (!interactive) {
        logger.debug('[OAuthManager] OAuth authorization requested in background mode (non-interactive).');
      } else {
        logger.debug('[OAuthManager] OAuth authorization requested with interactive permission.');
      }
      this.pendingAuthPromise = this.launchAuthFlow(authorizationUrl, interactive);
    }
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const sessions = await loadSessions();
    const prev = sessions[this.sessionKey] ?? { updatedAt: Date.now() };
    sessions[this.sessionKey] = {
      ...prev,
      codeVerifier,
      updatedAt: Date.now(),
    };
    await saveSessions(sessions);
  }

  async codeVerifier(): Promise<string> {
    const sessions = await loadSessions();
    const value = sessions[this.sessionKey]?.codeVerifier;
    if (!value) {
      throw new Error('OAuth code verifier not found');
    }
    return value;
  }

  isAuthorizing(): boolean {
    return this.pendingAuthPromise !== null;
  }

  async waitForAuthorizationCode(): Promise<string> {
    if (!this.pendingAuthPromise) {
      throw new Error('OAuth authorization has not been started');
    }
    try {
      return await this.pendingAuthPromise;
    } finally {
      this.pendingAuthPromise = null;
    }
  }

  async clearSessionData(): Promise<void> {
    const sessions = await loadSessions();
    if (sessions[this.sessionKey]) {
      delete sessions[this.sessionKey];
      await saveSessions(sessions);
    }
    this.pendingAuthPromise = null;
  }

  private launchAuthFlow(authorizationUrl: URL, interactive: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        {
          url: authorizationUrl.toString(),
          interactive,
        },
        redirectResponse => {
          if (chrome.runtime.lastError) {
            const suffix = interactive
              ? chrome.runtime.lastError.message
              : `${chrome.runtime.lastError.message}. Interactive OAuth is disabled for background retries; click Connect/Reconnect to authorize.`;
            reject(new Error(`OAuth web auth failed: ${suffix}`));
            return;
          }

          if (!redirectResponse) {
            reject(new Error('OAuth flow was canceled or returned an empty redirect URL'));
            return;
          }

          try {
            const redirected = new URL(redirectResponse);
            const error = redirected.searchParams.get('error');
            if (error) {
              const description = redirected.searchParams.get('error_description');
              reject(new Error(`OAuth error: ${error}${description ? ` (${description})` : ''}`));
              return;
            }

            const code = redirected.searchParams.get('code');
            if (!code) {
              reject(new Error('OAuth redirect missing authorization code'));
              return;
            }

            resolve(code);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );
    });
  }
}

export class OAuthManager {
  private providers = new Map<string, ChromeOAuthProvider>();
  private interactivePermissionBudget = new Map<string, number>();

  allowInteractiveAuth(serverUrl: string, attempts = 1): void {
    const key = encodeSessionKey(serverUrl);
    const current = this.interactivePermissionBudget.get(key) || 0;
    this.interactivePermissionBudget.set(key, Math.max(0, current + attempts));
  }

  private consumeInteractiveAuthPermission(serverUrl: string): boolean {
    const key = encodeSessionKey(serverUrl);
    const remaining = this.interactivePermissionBudget.get(key) || 0;
    if (remaining > 0) {
      if (remaining === 1) {
        this.interactivePermissionBudget.delete(key);
      } else {
        this.interactivePermissionBudget.set(key, remaining - 1);
      }
      return true;
    }
    return false;
  }

  getProvider(serverUrl: string, config: OAuthConfig): InteractiveOAuthProvider | undefined {
    if (!config.enabled) return undefined;

    const key = encodeSessionKey(serverUrl);
    const existing = this.providers.get(key);
    if (existing) {
      existing.updateConfig(config);
      return existing;
    }

    const provider = new ChromeOAuthProvider(
      serverUrl,
      config,
      () => this.consumeInteractiveAuthPermission(serverUrl),
    );
    this.providers.set(key, provider);
    return provider;
  }

  async getStatus(serverUrl: string, config: OAuthConfig): Promise<{
    enabled: boolean;
    hasTokens: boolean;
    isAuthorizing: boolean;
    error?: string;
  }> {
    if (!config.enabled) {
      return { enabled: false, hasTokens: false, isAuthorizing: false };
    }

    const provider = this.getProvider(serverUrl, config);
    if (!provider) {
      return { enabled: false, hasTokens: false, isAuthorizing: false };
    }

    try {
      const tokens = await provider.tokens();
      return {
        enabled: true,
        hasTokens: !!tokens?.access_token,
        isAuthorizing: provider.isAuthorizing?.() ?? false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        enabled: true,
        hasTokens: false,
        isAuthorizing: provider.isAuthorizing?.() ?? false,
        error: message,
      };
    }
  }

  buildTransportConfig(
    serverUrl: string,
    type: TransportType,
    config: OAuthConfig,
  ): { authProvider?: OAuthClientProvider } {
    if (!config.enabled || (type !== 'sse' && type !== 'streamable-http')) {
      return {};
    }
    const provider = this.getProvider(serverUrl, config);
    return provider ? { authProvider: provider } : {};
  }

  async clearCredentials(serverUrl: string, config: OAuthConfig): Promise<void> {
    const key = encodeSessionKey(serverUrl);
    const sessions = await loadSessions();
    if (sessions[key]) {
      delete sessions[key];
      await saveSessions(sessions);
    }
    const provider = this.providers.get(key);
    if (provider?.clearSessionData) {
      await provider.clearSessionData();
    }
    this.providers.delete(key);
    logger.debug('[OAuthManager] Cleared OAuth credentials for server', serverUrl);
  }

  async ensureAuthCode(serverUrl: string, config: OAuthConfig): Promise<string> {
    const provider = this.getProvider(serverUrl, config);
    if (!provider?.waitForAuthorizationCode) {
      throw new Error('OAuth provider is not initialized for this server');
    }
    return await provider.waitForAuthorizationCode();
  }
}
