import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

/**
 * PONTO DE EXTENSÃO DE AUTENTICAÇÃO (não implementado de propósito — ver ARCHITECTURE.md §Autenticação).
 *
 * Desenho pretendido: cada provedor de jogos é um client OIDC (client_credentials) num IdP externo
 * (Keycloak). O guard validaria o JWT pelo JWKS do IdP e resolveria a identidade do provedor por
 * esta porta. Depois, o use case checaria que `body.providerId === identity.providerId`.
 */
export interface ProviderIdentity {
  providerId: string;
}

export interface ProviderIdentityPort {
  resolve(authorizationHeader: string | undefined): Promise<ProviderIdentity | undefined>;
}

/** Guard no-op: hoje deixa tudo passar. Trocar a implementação aqui não exige mexer nos controllers. */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
