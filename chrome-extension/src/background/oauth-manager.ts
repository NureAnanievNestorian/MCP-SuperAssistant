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
  pendingFlow?: StoredPendingOAuthFlow;
  updatedAt: number;
}

type SessionStore = Record<string, StoredOAuthSession>;

type OAuthFlowStage =
  | 'initialized'
  | 'client_registered'
  | 'authorize_opened'
  | 'callback_received'
  | 'token_exchange_started';

interface StoredPendingOAuthFlow {
  flowId: string;
  runtimeSessionId: string;
  state: string;
  codeVerifier?: string;
  clientId?: string;
  redirectUri: string;
  resource?: string;
  startedAt: number;
  updatedAt: number;
  stage: OAuthFlowStage;
}

type InteractiveOAuthProvider = OAuthClientProvider & {
  waitForAuthorizationCode?: () => Promise<string>;
  isAuthorizing?: () => boolean;
  clearSessionData?: () => Promise<void>;
  resetForFreshAuth?: () => Promise<void>;
  failPendingFlow?: (reason: string, error?: unknown) => Promise<void>;
  getFlowDebugInfo?: () => Promise<StoredPendingOAuthFlow | null>;
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

function parseStatusCode(message: string): number | undefined {
  const match = message.match(/\b([45]\d{2})\b/);
  if (!match) return undefined;
  return Number(match[1]);
}

class ChromeOAuthProvider implements InteractiveOAuthProvider {
  public clientMetadataUrl?: string;

  private readonly sessionKey: string;
  private readonly runtimeSessionId: string;
  private authWindowPromise: Promise<string> | null = null;
  private activeFlow: StoredPendingOAuthFlow | null = null;

  constructor(
    private readonly serverUrl: string,
    private config: OAuthConfig,
    private readonly consumeInteractivePermission: () => boolean,
  ) {
    this.sessionKey = encodeSessionKey(serverUrl);
    this.clientMetadataUrl = config.clientMetadataUrl;
    this.runtimeSessionId = randomState();
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
    const active = this.ensureActiveFlow();
    if (active.stage !== 'initialized') {
      logger.debug('[OAuthManager] Reusing pending OAuth state because flow is already active.', {
        serverUrl: this.serverUrl,
        flowId: active.flowId,
        stage: active.stage,
      });
      return active.state;
    }

    void this.persistActiveFlow(active);
    logger.debug('[OAuthManager] auth flow started', {
      serverUrl: this.serverUrl,
      flowId: active.flowId,
      redirectUri: active.redirectUri,
    });
    return active.state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const active = this.ensureActiveFlow();
    if (this.config.clientId) {
      const configured = {
        client_id: this.config.clientId,
        ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
      };
      if (active.clientId !== configured.client_id) {
        active.clientId = configured.client_id;
        await this.persistActiveFlow(active);
      }
      return configured;
    }

    const sessions = await loadSessions();
    const info = sessions[this.sessionKey]?.clientInformation;
    if (info?.client_id && active.clientId !== info.client_id) {
      active.clientId = info.client_id;
      await this.persistActiveFlow(active);
    }
    return info;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    const sessions = await loadSessions();
    const prev = sessions[this.sessionKey] ?? { updatedAt: Date.now() };
    const active = this.ensureActiveFlow();
    active.clientId = clientInformation.client_id;
    active.stage = 'client_registered';
    sessions[this.sessionKey] = {
      ...prev,
      clientInformation,
      pendingFlow: active,
      updatedAt: Date.now(),
    };
    await saveSessions(sessions);
    this.activeFlow = active;
    logger.debug('[OAuthManager] client registered', {
      serverUrl: this.serverUrl,
      flowId: active.flowId,
      clientId: clientInformation.client_id,
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const sessions = await loadSessions();
    return sessions[this.sessionKey]?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const sessions = await loadSessions();
    const prev = sessions[this.sessionKey] ?? { updatedAt: Date.now() };
    const completedFlow = await this.loadActiveFlow();
    sessions[this.sessionKey] = {
      ...prev,
      tokens,
      pendingFlow: undefined,
      updatedAt: Date.now(),
    };
    await saveSessions(sessions);
    this.activeFlow = null;
    this.authWindowPromise = null;
    logger.debug('[OAuthManager] token exchange succeeded', {
      serverUrl: this.serverUrl,
      flowId: completedFlow?.flowId,
      hasRefreshToken: Boolean(tokens.refresh_token),
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    const active = this.ensureActiveFlow();
    const urlState = authorizationUrl.searchParams.get('state') || active.state;
    if (active.state !== urlState) {
      logger.warn('[OAuthManager] Stale authorization attempt ignored because state mismatch was detected before opening auth.', {
        serverUrl: this.serverUrl,
        flowId: active.flowId,
        expectedState: active.state,
        receivedState: urlState,
      });
      return;
    }

    active.clientId = authorizationUrl.searchParams.get('client_id') || active.clientId;
    active.resource = authorizationUrl.searchParams.get('resource') || undefined;
    active.stage = 'authorize_opened';
    void this.persistActiveFlow(active);

    if (!this.authWindowPromise) {
      const interactive = this.consumeInteractivePermission();
      if (!interactive) {
        logger.debug('[OAuthManager] OAuth authorization requested in background mode (non-interactive).');
      } else {
        logger.debug('[OAuthManager] OAuth authorization requested with interactive permission.');
      }
      logger.debug('[OAuthManager] authorize opened', {
        serverUrl: this.serverUrl,
        flowId: active.flowId,
        clientId: active.clientId,
        redirectUri: active.redirectUri,
        resource: active.resource,
      });
      this.authWindowPromise = this.launchAuthFlow(active, authorizationUrl, interactive);
    } else {
      logger.debug('[OAuthManager] retry suppressed because flow already pending', {
        serverUrl: this.serverUrl,
        flowId: active.flowId,
        stage: active.stage,
      });
    }
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const active = this.ensureActiveFlow();
    if (active.codeVerifier && active.codeVerifier !== codeVerifier) {
      logger.warn('[OAuthManager] Ignoring verifier overwrite while OAuth flow is already pending.', {
        serverUrl: this.serverUrl,
        flowId: active.flowId,
        stage: active.stage,
      });
      return;
    }
    active.codeVerifier = codeVerifier;
    await this.persistActiveFlow(active);
  }

  async codeVerifier(): Promise<string> {
    const active = await this.loadActiveFlow();
    const value = active?.codeVerifier;
    if (!value || !active) {
      throw new Error('OAuth code verifier not found');
    }
    active.stage = 'token_exchange_started';
    await this.persistActiveFlow(active);
    logger.debug('[OAuthManager] token exchange started', {
      serverUrl: this.serverUrl,
      flowId: active.flowId,
      clientId: active.clientId,
      redirectUri: active.redirectUri,
      resource: active.resource,
    });
    return value;
  }

  isAuthorizing(): boolean {
    return this.activeFlow !== null || this.authWindowPromise !== null;
  }

  async waitForAuthorizationCode(): Promise<string> {
    if (!this.authWindowPromise) {
      throw new Error('OAuth authorization has not been started');
    }
    return await this.authWindowPromise;
  }

  async clearSessionData(): Promise<void> {
    const sessions = await loadSessions();
    if (sessions[this.sessionKey]) {
      delete sessions[this.sessionKey];
      await saveSessions(sessions);
    }
    this.activeFlow = null;
    this.authWindowPromise = null;
  }

  async failPendingFlow(reason: string, error?: unknown): Promise<void> {
    const active = await this.loadActiveFlow();
    if (!active) return;

    const message = error instanceof Error ? error.message : error ? String(error) : undefined;
    logger.warn('[OAuthManager] token exchange failed', {
      serverUrl: this.serverUrl,
      flowId: active.flowId,
      stage: active.stage,
      reason,
      status: message ? parseStatusCode(message) : undefined,
      error: message,
    });

    const sessions = await loadSessions();
    const prev = sessions[this.sessionKey] ?? { updatedAt: Date.now() };
    sessions[this.sessionKey] = {
      ...prev,
      pendingFlow: undefined,
      updatedAt: Date.now(),
    };
    await saveSessions(sessions);
    this.activeFlow = null;
    this.authWindowPromise = null;
  }

  async resetForFreshAuth(): Promise<void> {
    const sessions = await loadSessions();
    sessions[this.sessionKey] = {
      updatedAt: Date.now(),
    };
    await saveSessions(sessions);
    this.activeFlow = null;
    this.authWindowPromise = null;
    logger.debug('[OAuthManager] Cleared cached OAuth state before starting a fresh flow.', {
      serverUrl: this.serverUrl,
    });
  }

  async getFlowDebugInfo(): Promise<StoredPendingOAuthFlow | null> {
    return await this.loadActiveFlow();
  }

  private async loadActiveFlow(): Promise<StoredPendingOAuthFlow | null> {
    if (this.activeFlow) {
      return this.activeFlow;
    }
    const sessions = await loadSessions();
    const flow = sessions[this.sessionKey]?.pendingFlow;
    if (!flow) {
      return null;
    }
    if (flow.runtimeSessionId !== this.runtimeSessionId) {
      logger.debug('[OAuthManager] Ignoring stale OAuth flow from a previous background session.', {
        serverUrl: this.serverUrl,
        flowId: flow.flowId,
      });
      return null;
    }
    this.activeFlow = flow;
    return flow;
  }

  private ensureActiveFlow(): StoredPendingOAuthFlow {
    if (this.activeFlow) {
      return this.activeFlow;
    }

    this.activeFlow = {
      flowId: randomState(),
      runtimeSessionId: this.runtimeSessionId,
      state: randomState(),
      redirectUri: this.redirectUrl,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      stage: 'initialized',
    };
    return this.activeFlow;
  }

  private async persistActiveFlow(flow: StoredPendingOAuthFlow): Promise<void> {
    flow.updatedAt = Date.now();
    this.activeFlow = flow;
    const sessions = await loadSessions();
    const prev = sessions[this.sessionKey] ?? { updatedAt: Date.now() };
    sessions[this.sessionKey] = {
      ...prev,
      pendingFlow: flow,
      updatedAt: Date.now(),
    };
    await saveSessions(sessions);
  }

  private launchAuthFlow(activeFlow: StoredPendingOAuthFlow, authorizationUrl: URL, interactive: boolean): Promise<string> {
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
            this.authWindowPromise = null;
            reject(new Error(`OAuth web auth failed: ${suffix}`));
            return;
          }

          if (!redirectResponse) {
            this.authWindowPromise = null;
            reject(new Error('OAuth flow was canceled or returned an empty redirect URL'));
            return;
          }

          try {
            const redirected = new URL(redirectResponse);
            const returnedState = redirected.searchParams.get('state');
            logger.debug('[OAuthManager] callback received with state', {
              serverUrl: this.serverUrl,
              flowId: activeFlow.flowId,
              expectedState: activeFlow.state,
              receivedState: returnedState,
            });
            if (!returnedState || returnedState !== activeFlow.state) {
              this.authWindowPromise = null;
              logger.warn('[OAuthManager] stale callback ignored because state mismatch', {
                serverUrl: this.serverUrl,
                flowId: activeFlow.flowId,
                expectedState: activeFlow.state,
                receivedState: returnedState,
              });
              reject(new Error('OAuth callback state mismatch'));
              return;
            }
            const error = redirected.searchParams.get('error');
            if (error) {
              const description = redirected.searchParams.get('error_description');
              this.authWindowPromise = null;
              reject(new Error(`OAuth error: ${error}${description ? ` (${description})` : ''}`));
              return;
            }

            const code = redirected.searchParams.get('code');
            if (!code) {
              this.authWindowPromise = null;
              reject(new Error('OAuth redirect missing authorization code'));
              return;
            }

            activeFlow.stage = 'callback_received';
            void this.persistActiveFlow(activeFlow);
            resolve(code);
          } catch (error) {
            this.authWindowPromise = null;
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

  async resetForFreshAuth(serverUrl: string, config: OAuthConfig): Promise<void> {
    const provider = this.getProvider(serverUrl, config);
    await provider?.resetForFreshAuth?.();
  }

  async hasPendingFlow(serverUrl: string, config: OAuthConfig): Promise<boolean> {
    const provider = this.getProvider(serverUrl, config);
    const flow = await provider?.getFlowDebugInfo?.();
    return Boolean(flow);
  }

  async failPendingFlow(serverUrl: string, config: OAuthConfig, reason: string, error?: unknown): Promise<void> {
    const provider = this.getProvider(serverUrl, config);
    await provider?.failPendingFlow?.(reason, error);
  }

  async getFlowDebugInfo(serverUrl: string, config: OAuthConfig): Promise<StoredPendingOAuthFlow | null> {
    const provider = this.getProvider(serverUrl, config);
    return (await provider?.getFlowDebugInfo?.()) ?? null;
  }

  async ensureAuthCode(serverUrl: string, config: OAuthConfig): Promise<string> {
    const provider = this.getProvider(serverUrl, config);
    if (!provider?.waitForAuthorizationCode) {
      throw new Error('OAuth provider is not initialized for this server');
    }
    return await provider.waitForAuthorizationCode();
  }
}
