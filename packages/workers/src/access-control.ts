// compass: interocitor.mailbox-host.access-control

import { createMeshAuthorizationMiddleware } from "./worker.ts";
import type { MeshAuthorization, MeshMiddleware, MeshRequestContext } from "./types.ts";

/** Server-authenticated identity used to select an access grant. */
export interface MeshGrantPrincipal {
  /** Stable application subject identifier. */
  subjectId: string;
}

/**
 * Plaintext, server-protected grant for one canonical mesh namespace.
 *
 * @see {@link ../docs/mesh-control.md | Protected mesh control}
 *   — when grants are the right shape at all, what a chain has to carry, and
 *   how revocation and delegation are expected to be stored.
 */
export interface MeshAccessGrant {
  /** Immutable grant identifier. */
  grantId: string;
  /** Parent grant, or `null` for an application-trusted root. */
  parentGrantId: string | null;
  /** Canonical Worker storage namespace; never a presented route alias. */
  canonicalAddress: string;
  /** Subject that issued this grant. */
  issuerSubjectId: string;
  /** Subject that may exercise this grant. */
  subjectId: string;
  /** Maximum mesh access conferred by this grant. */
  authorization: "readonly" | "full";
  /** Maximum number of further delegation edges. */
  delegationDepth: number;
  /** Inclusive Unix-millisecond issue and activation time. */
  issuedAt: number;
  /** Optional inclusive Unix-millisecond start time. */
  notBefore?: number;
  /** Optional exclusive Unix-millisecond expiry time. */
  expiresAt?: number;
  /** Set when the grant has been revoked. Any value makes it inactive. */
  revokedAt?: number;
}

/** Fields a grant holder may choose while creating an attenuated child grant. */
export interface MeshGrantAttenuation {
  grantId: string;
  subjectId: string;
  authorization: "readonly" | "full";
  delegationDepth: number;
  issuedAt: number;
  notBefore?: number;
  expiresAt?: number;
}

/** Storage-agnostic inputs for {@link createMeshGrantAuthorizationMiddleware}. */
export interface MeshGrantAuthorizationOptions<Env = unknown> {
  /** Authenticate the request with the host application's identity system. */
  authenticate(
    context: MeshRequestContext,
    env: Env,
  ): MeshGrantPrincipal | null | Promise<MeshGrantPrincipal | null>;
  /**
   * Load the current authoritative grant chain in root-to-leaf order.
   * Implementations must consult revocation state rather than trusting a
   * client-supplied grant document as the source of truth.
   */
  loadGrantChain(
    subjectId: string,
    context: MeshRequestContext,
    env: Env,
  ): readonly MeshAccessGrant[] | null | Promise<readonly MeshAccessGrant[] | null>;
  /** Confirm that the first grant is a root trusted by application policy. */
  isTrustedRoot(
    root: MeshAccessGrant,
    context: MeshRequestContext,
    env: Env,
  ): boolean | Promise<boolean>;
  /** Clock used for validity checks. Defaults to `Date.now`. */
  now?: () => number;
  /** Conceal missing, inactive, or insufficient grants as `404`. Defaults to `true`. */
  concealDenied?: boolean;
  /** Maximum accepted root-to-leaf chain length. Defaults to 32. */
  maxChainLength?: number;
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertTimestamp(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${name} must be a non-negative finite timestamp`);
  }
}

function assertRequiredTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite timestamp`);
  }
}

function assertGrantShape(grant: MeshAccessGrant): void {
  assertNonEmpty(grant.grantId, "grantId");
  assertNonEmpty(grant.canonicalAddress, "canonicalAddress");
  assertNonEmpty(grant.issuerSubjectId, "issuerSubjectId");
  assertNonEmpty(grant.subjectId, "subjectId");
  if (grant.parentGrantId !== null) assertNonEmpty(grant.parentGrantId, "parentGrantId");
  if (grant.authorization !== "readonly" && grant.authorization !== "full") {
    throw new TypeError("authorization must be readonly or full");
  }
  if (!Number.isSafeInteger(grant.delegationDepth) || grant.delegationDepth < 0) {
    throw new TypeError("delegationDepth must be a non-negative safe integer");
  }
  assertRequiredTimestamp(grant.issuedAt, "issuedAt");
  assertTimestamp(grant.notBefore, "notBefore");
  assertTimestamp(grant.expiresAt, "expiresAt");
  assertTimestamp(grant.revokedAt, "revokedAt");
  if (
    grant.notBefore !== undefined &&
    grant.expiresAt !== undefined &&
    grant.notBefore >= grant.expiresAt
  ) {
    throw new TypeError("grant validity window must be non-empty");
  }
  if (grant.expiresAt !== undefined && grant.issuedAt >= grant.expiresAt) {
    throw new TypeError("grant must be issued before it expires");
  }
  if (grant.revokedAt !== undefined && grant.revokedAt < grant.issuedAt) {
    throw new TypeError("grant cannot be revoked before it is issued");
  }
}

function snapshotGrant(value: unknown): MeshAccessGrant {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("grant must be an object");
  }
  const {
    grantId,
    parentGrantId,
    canonicalAddress,
    issuerSubjectId,
    subjectId,
    authorization,
    delegationDepth,
    issuedAt,
    notBefore,
    expiresAt,
    revokedAt,
  } = value as Record<string, unknown>;
  const grant = {
    grantId,
    parentGrantId,
    canonicalAddress,
    issuerSubjectId,
    subjectId,
    authorization,
    delegationDepth,
    issuedAt,
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  } as MeshAccessGrant;
  assertGrantShape(grant);
  return Object.freeze(grant);
}

function snapshotGrantChain(value: unknown, maxChainLength: number): readonly MeshAccessGrant[] {
  if (!Array.isArray(value)) throw new TypeError("grant chain must be an array");
  const entries: MeshAccessGrant[] = [];
  const length = value.length;
  if (length > maxChainLength) throw new TypeError("grant chain exceeds maximum length");
  for (let index = 0; index < length; index++) {
    if (!(index in value)) throw new TypeError("grant chain must not contain holes");
    entries.push(snapshotGrant(value[index]));
  }
  return Object.freeze(entries);
}

function snapshotAttenuation(value: unknown): MeshGrantAttenuation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("child grant must be an object");
  }
  const { grantId, subjectId, authorization, delegationDepth, issuedAt, notBefore, expiresAt } =
    value as Record<string, unknown>;
  return Object.freeze({
    grantId,
    subjectId,
    authorization,
    delegationDepth,
    issuedAt,
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  } as MeshGrantAttenuation);
}

function authorizationRank(value: "readonly" | "full"): number {
  return value === "full" ? 2 : 1;
}

function cloneContext(context: MeshRequestContext): MeshRequestContext {
  return { ...context, request: context.request.clone() };
}

function validateGrantChain(
  chain: readonly MeshAccessGrant[],
  context: MeshRequestContext,
  subjectId: string,
  now: number,
  maxChainLength: number,
): { leaf: MeshAccessGrant; active: boolean } {
  if (chain.length === 0) throw new TypeError("grant chain must not be empty");
  if (chain.length > maxChainLength) throw new TypeError("grant chain exceeds maximum length");
  const seen = new Set<string>();
  let active = true;

  for (let index = 0; index < chain.length; index++) {
    const grant = chain[index]!;
    assertGrantShape(grant);
    if (seen.has(grant.grantId)) throw new TypeError("grant chain contains a cycle");
    seen.add(grant.grantId);
    if (grant.canonicalAddress !== context.canonicalAddress) {
      throw new TypeError("grant canonical address does not match the request");
    }
    if (grant.revokedAt !== undefined) active = false;
    if (now < grant.issuedAt) active = false;
    if (grant.notBefore !== undefined && now < grant.notBefore) active = false;
    if (grant.expiresAt !== undefined && now >= grant.expiresAt) active = false;

    const parent = index === 0 ? undefined : chain[index - 1];
    if (!parent) {
      if (grant.parentGrantId !== null) throw new TypeError("grant chain root has a parent");
      continue;
    }
    if (grant.parentGrantId !== parent.grantId) {
      throw new TypeError("grant parent link does not match the chain");
    }
    if (grant.issuerSubjectId !== parent.subjectId) {
      throw new TypeError("grant issuer does not hold the parent grant");
    }
    if (grant.issuedAt < parent.issuedAt) throw new TypeError("grant predates its parent");
    if (authorizationRank(grant.authorization) > authorizationRank(parent.authorization)) {
      throw new TypeError("grant authorization exceeds its parent");
    }
    if (parent.delegationDepth === 0 || grant.delegationDepth >= parent.delegationDepth) {
      throw new TypeError("grant delegation depth exceeds its parent");
    }
    if (
      parent.notBefore !== undefined &&
      (grant.notBefore === undefined || grant.notBefore < parent.notBefore)
    ) {
      throw new TypeError("grant starts before its parent");
    }
    if (
      parent.expiresAt !== undefined &&
      (grant.expiresAt === undefined || grant.expiresAt > parent.expiresAt)
    ) {
      throw new TypeError("grant expires after its parent");
    }
  }

  const leaf = chain.at(-1)!;
  if (leaf.subjectId !== subjectId) throw new TypeError("grant subject does not match principal");
  return { leaf, active };
}

/**
 * Create IO/notify mesh middleware backed by current, server-protected
 * plaintext grants. The helper handles attenuation, validity, ancestor
 * revocation, and access classification for each admitted request;
 * authentication and persistence remain application-owned.
 *
 * @see {@link ../docs/mesh-control.md | Protected mesh control}
 *   — the parts the application still owns, and the simpler alternative for
 *   ordinary multi-user access.
 */
export function createMeshGrantAuthorizationMiddleware<Env = unknown>(
  options: MeshGrantAuthorizationOptions<Env>,
): MeshMiddleware<Env> {
  const maxChainLength = options.maxChainLength ?? 32;
  if (!Number.isSafeInteger(maxChainLength) || maxChainLength <= 0) {
    throw new TypeError("maxChainLength must be a positive safe integer");
  }

  return createMeshAuthorizationMiddleware<Env>(
    async (context, env): Promise<MeshAuthorization> => {
      const principal = await options.authenticate(cloneContext(context), env);
      if (principal === null) return "deny";
      if (!principal || typeof principal !== "object" || Array.isArray(principal)) {
        throw new TypeError("authenticate returned an invalid principal");
      }
      const subjectId = principal.subjectId;
      if (typeof subjectId !== "string" || !subjectId) {
        throw new TypeError("authenticate returned an invalid principal");
      }
      const loadedChain = await options.loadGrantChain(subjectId, cloneContext(context), env);
      if (loadedChain === null) return "deny";
      const chain = snapshotGrantChain(loadedChain, maxChainLength);
      const now = (options.now ?? Date.now)();
      if (!Number.isFinite(now) || now < 0)
        throw new TypeError("now returned an invalid timestamp");
      const { leaf, active } = validateGrantChain(chain, context, subjectId, now, maxChainLength);
      const trustedRoot = await options.isTrustedRoot(chain[0]!, cloneContext(context), env);
      if (trustedRoot === false) return "deny";
      if (trustedRoot !== true) throw new TypeError("isTrustedRoot returned a non-boolean result");
      return active ? leaf.authorization : "deny";
    },
    { concealDenied: options.concealDenied ?? true },
  );
}

/** Create a child grant while enforcing rights, time, and depth attenuation. */
export function attenuateMeshGrant(
  parent: MeshAccessGrant,
  child: MeshGrantAttenuation,
): MeshAccessGrant {
  const parentGrant = snapshotGrant(parent);
  const childGrant = snapshotAttenuation(child);
  assertNonEmpty(childGrant.grantId, "grantId");
  assertNonEmpty(childGrant.subjectId, "subjectId");
  if (childGrant.grantId === parentGrant.grantId)
    throw new TypeError("child grant id must be unique");
  if (parentGrant.revokedAt !== undefined) throw new TypeError("a revoked grant cannot delegate");
  if (childGrant.authorization !== "readonly" && childGrant.authorization !== "full") {
    throw new TypeError("authorization must be readonly or full");
  }
  if (authorizationRank(childGrant.authorization) > authorizationRank(parentGrant.authorization)) {
    throw new TypeError("child authorization exceeds its parent");
  }
  if (!Number.isSafeInteger(childGrant.delegationDepth) || childGrant.delegationDepth < 0) {
    throw new TypeError("delegationDepth must be a non-negative safe integer");
  }
  if (
    parentGrant.delegationDepth === 0 ||
    childGrant.delegationDepth >= parentGrant.delegationDepth
  ) {
    throw new TypeError("child delegation depth exceeds its parent");
  }
  assertRequiredTimestamp(childGrant.issuedAt, "issuedAt");
  if (childGrant.issuedAt < parentGrant.issuedAt) throw new TypeError("child predates its parent");

  const notBefore = childGrant.notBefore ?? parentGrant.notBefore;
  const expiresAt = childGrant.expiresAt ?? parentGrant.expiresAt;
  assertTimestamp(notBefore, "notBefore");
  assertTimestamp(expiresAt, "expiresAt");
  if (parentGrant.notBefore !== undefined && notBefore! < parentGrant.notBefore) {
    throw new TypeError("child starts before its parent");
  }
  if (parentGrant.expiresAt !== undefined && expiresAt! > parentGrant.expiresAt) {
    throw new TypeError("child expires after its parent");
  }
  if (notBefore !== undefined && expiresAt !== undefined && notBefore >= expiresAt) {
    throw new TypeError("child validity window must be non-empty");
  }
  if (expiresAt !== undefined && childGrant.issuedAt >= expiresAt) {
    throw new TypeError("child must be issued before it expires");
  }

  return Object.freeze({
    grantId: childGrant.grantId,
    parentGrantId: parentGrant.grantId,
    canonicalAddress: parentGrant.canonicalAddress,
    issuerSubjectId: parentGrant.subjectId,
    subjectId: childGrant.subjectId,
    authorization: childGrant.authorization,
    delegationDepth: childGrant.delegationDepth,
    issuedAt: childGrant.issuedAt,
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

/** Return an immutable revoked copy for the host application to persist. */
export function markMeshGrantRevoked(
  grant: MeshAccessGrant,
  revokedAt: number = Date.now(),
): MeshAccessGrant {
  const stableGrant = snapshotGrant(grant);
  assertRequiredTimestamp(revokedAt, "revokedAt");
  if (revokedAt < stableGrant.issuedAt)
    throw new TypeError("grant cannot be revoked before it is issued");
  return Object.freeze({ ...stableGrant, revokedAt: stableGrant.revokedAt ?? revokedAt });
}
