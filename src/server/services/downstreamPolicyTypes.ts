export type DownstreamAccountTokenCredentialRef = {
  kind: 'account_token';
  siteId: number;
  accountId: number;
  tokenId: number;
};

export type DownstreamDefaultApiKeyCredentialRef = {
  kind: 'default_api_key';
  siteId: number;
  accountId: number;
};

export type DownstreamExcludedCredentialRef =
  | DownstreamAccountTokenCredentialRef
  | DownstreamDefaultApiKeyCredentialRef;

export type DownstreamAssignmentMode = 'auto' | 'pool' | 'custom';

export interface DownstreamRoutingPolicy {
  assignmentMode?: DownstreamAssignmentMode;
  sitePoolId?: number | null;
  allowedSiteIds: number[];
  supportedModels: string[];
  allowedRouteIds: number[];
  siteWeightMultipliers: Record<number, number>;
  excludedSiteIds: number[];
  excludedCredentialRefs: DownstreamExcludedCredentialRef[];
  denyAllWhenEmpty?: boolean;
}

export const EMPTY_DOWNSTREAM_ROUTING_POLICY: DownstreamRoutingPolicy = {
  assignmentMode: 'auto',
  sitePoolId: null,
  allowedSiteIds: [],
  supportedModels: [],
  allowedRouteIds: [],
  siteWeightMultipliers: {},
  excludedSiteIds: [],
  excludedCredentialRefs: [],
};
