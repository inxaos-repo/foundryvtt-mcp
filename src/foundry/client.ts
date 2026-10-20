/**
 * FoundryVTT client for API communication via Socket.IO
 *
 * Connects to FoundryVTT using the proven 4-step authentication flow,
 * caches worldData in memory, and serves all queries from the snapshot.
 */

import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { io, type Socket } from 'socket.io-client';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { authenticateFoundry, sessionSocketOptions } from './auth.js';
import { evaluateDiceFormula } from './dice-formula.js';
import { buildTokenMovement, isMovementUpdate } from './token-movement.js';
import type {
  ActorAttributeUpdateResult,
  ActorItemCreateSource,
  ActorSearchResult,
  CompendiumSearchResult,
  DiceRoll,
  DocumentVisibility,
  FoundryActor,
  FoundryItem,
  FoundryScene,
  FoundryWorld,
  ItemSearchResult,
  JournalPageCreateSource,
  WorldActor,
  WorldCombat,
  WorldData,
  WorldEffect,
  WorldItem,
  WorldJournal,
  WorldMessage,
  WorldScene,
  WorldUser,
} from './types.js';
import { VISIBILITY_LEVELS } from './types.js';
import {
  applyDocumentBroadcast,
  applyUserActivity,
  parseDocumentBroadcast,
  parseUserActivity,
} from './world-cache.js';

/** FoundryVTT document IDs are 16-character alphanumeric strings. */
const FOUNDRY_ID_PATTERN = /^[a-zA-Z0-9]{16}$/;

/**
 * Characters a dice formula may contain. A cheap sanity gate, not a grammar:
 * it rejects Foundry modifier syntax (`4d6kh3`), attribute references
 * (`1d20+STR`) and arithmetic this server never forwards (`*`, `/`), while
 * still allowing parentheses through to FoundryVTT's own `Roll` engine on the
 * REST transport. See {@link FoundryClient.rollDice}.
 */
const DICE_FORMULA_ALPHABET = /^[0-9d\s+\-()]+$/;

/** Single-character form of {@link DICE_FORMULA_ALPHABET}, for locating a violation. */
const DICE_FORMULA_CHARACTER = /[0-9d\s+\-()]/;

/** Upper bound on formula length, common to both transports. */
const MAX_DICE_FORMULA_LENGTH = 100;

/**
 * Builds the REST-path rejection for a formula outside the dice alphabet.
 *
 * The local parser cannot be borrowed for this: it rejects parentheses, which
 * REST *does* support, so for `(1d20+5)*2` it would name the wrong problem.
 * This scans for the first character the alphabet does not admit and reports
 * it by name and position, so the REST path is as specific about what it
 * refused as the local one (#219).
 */
function alphabetViolation(formula: string): Error {
  if (formula === '') {
    return new Error('Invalid dice formula: the formula is empty.');
  }
  const index = [...formula].findIndex((char) => !DICE_FORMULA_CHARACTER.test(char));
  if (index === -1) {
    return new Error(`Invalid dice formula: ${formula}`);
  }
  return new Error(
    `Invalid dice formula "${formula}": unexpected "${formula[index]}" at position ${index}. ` +
      'Supported syntax: dice terms (NdS, or dS for a single die) and whole numbers, joined by ' +
      '+ or -, optionally grouped in parentheses.',
  );
}

/**
 * True when a rejected request carries an HTTP response — FoundryVTT answered,
 * whatever the status. A rejection without one is a transport failure
 * (connection refused or reset, DNS, timeout): the server is not reachable.
 *
 * Read reflectively rather than cast, so a non-axios rejection cannot be
 * mistaken for a reply.
 */
function hasHttpResponse(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const response = Reflect.get(error, 'response');
  return response !== undefined && response !== null;
}

/**
 * Spacing between sibling `sort` values, mirroring Foundry's
 * `CONST.SORT_INTEGER_DENSITY`. Leaving every sibling at the default `0` makes
 * ordering depend on incidental collection insertion order, and gives Foundry
 * no gap to slot a UI-created sibling into later.
 */
const SORT_INTEGER_DENSITY = 100000;

/**
 * Accepts the parent-UUID forms a token's actor can take:
 *  - `Actor.<id>` — a world-linked actor (`actorLink: true`)
 *  - `Scene.<sid>.Token.<tid>.Actor.<aid>` — an unlinked token's synthetic actor
 *  - `Scene.<sid>.Token.<tid>.ActorDelta.<did>` — the delta that stores it
 */
const TOKEN_ACTOR_UUID_PATTERN =
  /^(Actor\.[a-zA-Z0-9]{16}|Scene\.[a-zA-Z0-9]{16}\.Token\.[a-zA-Z0-9]{16}\.(Actor|ActorDelta)\.[a-zA-Z0-9]{16})$/;

/**
 * Embedded documents of an unlinked token's synthetic actor are stored on the
 * token's ActorDelta, and the server only accepts them with the delta as the
 * parent (`Scene.<sid>.Token.<tid>.ActorDelta.<did>`), which is what browser
 * clients send. Rewrites the synthetic-actor form to the delta form.
 */
export function effectParentUuid(
  uuid: string,
  findToken: (sceneId: string, tokenId: string) => Record<string, unknown> | undefined,
): string {
  const m = /^Scene\.([a-zA-Z0-9]{16})\.Token\.([a-zA-Z0-9]{16})\.Actor\.[a-zA-Z0-9]{16}$/.exec(
    uuid,
  );
  if (!m) {
    return uuid;
  }
  const [, sceneId = '', tokenId = ''] = m;
  const token = findToken(sceneId, tokenId);
  const delta = token?.delta as { _id?: string } | undefined;
  return `Scene.${sceneId}.Token.${tokenId}.ActorDelta.${delta?._id ?? tokenId}`;
}

/**
 * Minimal Zod schema for the `/api/dice/roll` REST response.
 *
 * The REST module is external input, so the body is validated rather than read
 * off an `any`: a 200 whose payload carries no numeric `total` would otherwise
 * produce a `DiceRoll` with `total: undefined` while the type claims `number`,
 * and `roll_dice` would render that straight to the caller. A body that does
 * not match is treated like any other REST failure and falls through to the
 * local roller.
 */
const RestDiceRollSchema = z.object({
  total: z.number(),
  terms: z.array(z.object({ results: z.array(z.number()).optional() })).optional(),
});

/**
 * Minimal Zod schema for the WorldData Socket.IO payload.
 * Validates the required top-level array fields; extra fields pass through.
 */
const WorldDataSchema = z.object({
  userId: z.string(),
  actors: z.array(z.unknown()),
  scenes: z.array(z.unknown()),
  items: z.array(z.unknown()),
  journal: z.array(z.unknown()),
  messages: z.array(z.unknown()),
  combats: z.array(z.unknown()),
  users: z.array(z.unknown()),
  activeUsers: z.array(z.string()),
  macros: z.array(z.unknown()),
  playlists: z.array(z.unknown()),
  tables: z.array(z.unknown()),
  folders: z.array(z.unknown()),
});

export interface FoundryClientConfig {
  baseUrl: string;
  apiKey?: string;
  username?: string;
  password?: string;
  userId?: string;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
  socketPath?: string;
  /** Opt-in gate for game-state mutations (FOUNDRY_WRITE_ENABLED). Default false. */
  writeEnabled?: boolean;
}

/** Minimal shape of FoundryVTT's `modifyDocument` Socket.IO acknowledgement. */
interface DocumentSocketResponse {
  /** Created/updated data objects, or deleted ids, on success. */
  result?: unknown[];
  /** Present when the server rejects the operation. */
  error?: { message?: string } | null;
  userId?: string;
}

export interface SearchActorsParams {
  query?: string;
  type?: string;
  limit?: number;
}

export interface SearchItemsParams {
  query?: string;
  type?: string;
  rarity?: string;
  limit?: number;
}

export interface CompendiumSearchParams {
  query?: string;
  packType?: string;
  itemType?: string;
  spellLevel?: number;
  source?: string;
  compendiumId?: string;
  limit?: number;
  /** Opaque pagination cursor from a prior result's `nextCursor`. */
  cursor?: string;
}

/**
 * Shallow attribute patch for {@link FoundryClient.updateActorAttribute} (#143).
 *
 * Keys are dot-paths into the actor's `system` object (e.g.
 * `attributes.hp.value`, `currency.gp`, `spells.spell1.value`,
 * `attributes.exhaustion`). Values are the scalar to set at that path.
 */
export type AttributePatch = Record<string, number | string | boolean>;

export class FoundryClient {
  private http: AxiosInstance;
  private socket: Socket | null = null;
  private config: FoundryClientConfig;
  private _isConnected = false;
  private worldData: WorldData | null = null;
  /** Set when the socket drops with a cache still loaded (#217). */
  private worldDataStale = false;
  /**
   * Last observed outcome of a REST request: false once one failed to reach
   * FoundryVTT at all (#217). Unused in Socket.IO mode.
   */
  private restLinkLive = true;

  constructor(config: FoundryClientConfig) {
    if (!config.baseUrl || config.baseUrl.trim() === '') {
      throw new Error('baseUrl is required and cannot be empty');
    }

    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error(`Invalid baseUrl: ${config.baseUrl}`);
    }

    this.config = {
      timeout: 10000,
      retryAttempts: 3,
      retryDelay: 1000,
      socketPath: '/socket.io/',
      ...config,
    };

    this.http = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'FoundryMCP/0.2.0',
      },
      maxRedirects: 3,
      maxContentLength: 50 * 1024 * 1024,
      maxBodyLength: 50 * 1024 * 1024,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    if (this.config.apiKey) {
      this.http.interceptors.request.use((reqConfig) => {
        reqConfig.headers['x-api-key'] = this.config.apiKey;
        return reqConfig;
      });

      // REST mode has no socket to ask about liveness, so every request that
      // does happen doubles as the probe (#217). See `isConnected()`.
      this.http.interceptors.response.use(
        (response) => {
          this.restLinkLive = true;
          return response;
        },
        (error: unknown) => {
          this.restLinkLive = hasHttpResponse(error);
          return Promise.reject(error);
        },
      );
    }

    const mode = this.config.apiKey ? 'REST API' : 'Socket.IO';
    logger.info(`FoundryVTT client initialized (${mode} mode)`);
  }

  /**
   * Connects to FoundryVTT.
   * REST API mode: tests /api/status endpoint.
   * Socket.IO mode: authenticates and loads full worldData.
   */
  async connect(): Promise<void> {
    if (this.config.apiKey) {
      try {
        await this.http.get('/api/status');
        this._isConnected = true;
        logger.info('Connected to FoundryVTT via REST API module');
      } catch (error) {
        logger.error('Failed to connect via REST API module:', error);
        throw error;
      }
      return;
    }

    const user = this.config.userId || this.config.username;
    if (!user || !this.config.password) {
      throw new Error(
        'Socket.IO mode requires username/userId and password. ' +
          'Set FOUNDRY_USERNAME + FOUNDRY_PASSWORD or FOUNDRY_USER_ID + FOUNDRY_PASSWORD.',
      );
    }

    const { session } = await authenticateFoundry(this.config.baseUrl, user, this.config.password);

    // Connect authenticated socket and load world data
    this.worldData = await this.connectAndLoadWorld(session);
    this.worldDataStale = false;
    this._isConnected = true;
    logger.info('Connected to FoundryVTT via Socket.IO', {
      actors: this.worldData.actors.length,
      scenes: this.worldData.scenes.length,
      items: this.worldData.items.length,
    });
  }

  /**
   * Connects Socket.IO with an authenticated session and loads worldData.
   */
  private connectAndLoadWorld(session: string): Promise<WorldData> {
    // A previous socket must not outlive its replacement (see `detachSocket`).
    this.detachSocket();

    return new Promise((resolve, reject) => {
      this.socket = io(this.config.baseUrl, sessionSocketOptions(session));

      const cleanup = () => {
        this.socket?.off('session', onSession);
        this.socket?.off('connect_error', onConnectError);
      };

      const timeout = setTimeout(() => {
        cleanup();
        this.socket?.disconnect();
        reject(new Error('Timeout waiting for world data (15s)'));
      }, 15000);

      const onSession = (data: { userId?: string } | null) => {
        if (!data?.userId) {
          clearTimeout(timeout);
          cleanup();
          this.socket?.disconnect();
          return reject(new Error('Authentication failed — session event returned no userId'));
        }

        this.socket?.emit('world', (worldData: WorldData) => {
          clearTimeout(timeout);
          cleanup();
          const parsed = WorldDataSchema.safeParse(worldData);
          if (!parsed.success) {
            logger.warn('WorldData failed schema validation — proceeding with raw data', {
              issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            });
          }
          // Keep the snapshot live from here on (#205). Attached only after a
          // successful handshake so the reject paths have no listener to leak.
          this.socket?.on('modifyDocument', this.onDocumentBroadcast);
          // Presence (#218): `activeUsers` is not a document collection, so it
          // only moves on this event.
          this.socket?.on('userActivity', this.onUserActivity);
          // Liveness (#217): a socket that drops on its own must stop reading
          // as connected, and one that socket.io reconnects must read as
          // connected again. Both are removed in `disconnect()`.
          this.socket?.on('connect', this.onSocketConnect);
          this.socket?.on('disconnect', this.onSocketDisconnect);
          resolve(worldData);
        });
      };

      const onConnectError = (err: Error) => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`Socket.IO connection failed: ${err.message}`));
      };

      this.socket.on('session', onSession);
      this.socket.on('connect_error', onConnectError);
    });
  }

  /**
   * Applies a FoundryVTT `modifyDocument` broadcast to the cached world state (#205).
   *
   * Bound field rather than a method so the same reference can be passed to
   * `socket.off()` on teardown. Never throws: a malformed or unmodelled payload
   * leaves the cache untouched (and stale) rather than taking the connection down.
   */
  private onDocumentBroadcast = (payload: unknown): void => {
    if (!this.worldData) {
      return;
    }

    const broadcast = parseDocumentBroadcast(payload);
    if (!broadcast) {
      return;
    }

    try {
      const applied = applyDocumentBroadcast(this.worldData, broadcast);
      logger.debug(
        applied
          ? `Applied ${broadcast.action} ${broadcast.type} broadcast to cached worldData`
          : `Ignored ${broadcast.action} ${broadcast.type} broadcast (not cached)`,
      );
    } catch (error) {
      logger.warn('Failed to apply document broadcast to cached worldData', {
        type: broadcast.type,
        action: broadcast.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Latest scene id reported by each user's client via `userActivity`. */
  private viewedScenes = new Map<string, string>();
  private viewedSceneWaiters = new Set<() => void>();

  /**
   * Applies a FoundryVTT `userActivity` broadcast to cached presence (#218).
   *
   * Foundry emits this on login, on logout, and on ordinary activity, and it is
   * the only signal that moves `worldData.activeUsers` — that field is a
   * top-level `WorldData` entry, not a document collection, so the
   * `modifyDocument` path never touches it and `get_users` would otherwise
   * answer "who is connected?" from the connect-time snapshot forever.
   *
   * Bound field rather than a method so the same reference reaches `socket.off()`.
   * Never throws: an unrecognized payload leaves presence as it was.
   */
  private onUserActivity = (userId: unknown, activityData?: unknown): void => {
    // A client that finishes drawing a scene announces it with `sceneId`; keep
    // the latest per user so scene pulls can be confirmed.
    const viewed = (activityData as { sceneId?: unknown } | null | undefined)?.sceneId;
    if (typeof userId === 'string' && typeof viewed === 'string') {
      this.viewedScenes.set(userId, viewed);
      for (const waiter of this.viewedSceneWaiters) {
        waiter();
      }
    }
    if (!this.worldData) {
      return;
    }

    const activity = parseUserActivity(userId, activityData);
    if (!activity) {
      logger.debug('Ignored unrecognized userActivity payload');
      return;
    }

    if (applyUserActivity(this.worldData, activity)) {
      logger.debug(
        `User ${activity.userId} is now ${activity.active ? 'active' : 'inactive'} (userActivity)`,
      );
    }
  };

  /**
   * Reacts to the socket dropping on its own — server restart, network loss,
   * an idle timeout (#217).
   *
   * Clears the connected flag so `isConnected()` and `get_health_status` stop
   * claiming a live link, and marks the cached snapshot stale: nothing is
   * applying `modifyDocument` broadcasts while the socket is down, so whatever
   * is in `worldData` from here on is a point-in-time copy, not live state.
   * The cache is deliberately *kept* rather than dropped — a stale answer with
   * an honest connection line beats no answer at all — and Socket.IO's own
   * reconnect logic may bring the link back, at which point `refreshWorldData()`
   * resyncs it.
   *
   * Bound field rather than a method so the same reference reaches `socket.off()`.
   */
  /**
   * Reacts to socket.io bringing the link back up on its own (#217).
   *
   * `sessionSocketOptions` leaves socket.io-client's default
   * `reconnection: true` in place, so after a transient drop the manager
   * re-handshakes the SAME socket instance (the session cookie rides along in
   * `extraHeaders`) and the persistent `modifyDocument`/`userActivity`
   * listeners resume firing. Without this the connected flag would stay
   * latched off for the rest of the process while writes and broadcasts were
   * demonstrably working again.
   *
   * `worldDataStale` is deliberately *not* cleared: broadcasts emitted while
   * the socket was down were never delivered and are not replayed, so the
   * cache stays flagged until an explicit `refreshWorldData()`.
   *
   * Bound field rather than a method so the same reference reaches `socket.off()`.
   */
  private onSocketConnect = (): void => {
    this._isConnected = true;
    logger.info('FoundryVTT socket reconnected — cached world data is still stale until refreshed');
  };

  private onSocketDisconnect = (reason?: unknown): void => {
    this._isConnected = false;
    this.worldDataStale = this.worldData !== null;
    logger.warn('FoundryVTT socket disconnected — cached world data is now stale', {
      reason: typeof reason === 'string' ? reason : undefined,
    });
  };

  /**
   * Closes the current socket and removes every persistent listener bound to
   * it. Used both by `disconnect()` and before a socket is replaced: a
   * superseded socket that kept its `disconnect` handler would otherwise clear
   * the connected flag of the live socket that replaced it when it finally
   * closed (`DiagnosticsClient.testAuthentication()` re-connects a live
   * client, so this is reachable in-repo).
   */
  private detachSocket(): void {
    if (!this.socket) {
      return;
    }
    this.socket.off('modifyDocument', this.onDocumentBroadcast);
    this.socket.off('userActivity', this.onUserActivity);
    this.socket.off('connect', this.onSocketConnect);
    this.socket.off('disconnect', this.onSocketDisconnect);
    this.socket.disconnect();
    this.socket = null;
  }

  async disconnect(): Promise<void> {
    this.detachSocket();
    this.worldData = null;
    this.worldDataStale = false;
    this._isConnected = false;
    this.restLinkLive = true;
    logger.info('FoundryVTT client disconnected');
  }

  /**
   * Reports whether the client currently has a live link to FoundryVTT (#217).
   *
   * Socket.IO mode answers from the socket itself rather than from a latched
   * flag, so a link that dropped without an explicit `disconnect()` — server
   * restart, network loss — reads as disconnected immediately, even if the
   * `disconnect` event has not been delivered yet. It tracks the socket in both
   * directions: an automatic reconnect (`onSocketConnect`) reads as connected
   * again rather than staying latched off.
   *
   * REST API mode (`FOUNDRY_API_KEY`) has no socket to ask, so it answers from
   * the last REST request that actually happened: a request that failed to
   * reach FoundryVTT (connection refused, reset, timed out) reads as
   * disconnected from then on, and the next request that gets through reads as
   * connected again. An HTTP error status does not count as a drop — the
   * server answered. This is a *last observed outcome*, not a live probe: it
   * cannot notice a server that went away between requests, and it never does
   * I/O of its own, because this accessor is synchronous and widely called.
   */
  isConnected(): boolean {
    if (this.config.apiKey) {
      return this._isConnected && this.restLinkLive;
    }
    return this._isConnected && this.socket?.connected === true;
  }

  /**
   * True when the cached snapshot is no longer being kept live by broadcasts —
   * i.e. the socket dropped after a world load (#217). Reads still answer from
   * the cache; this flags that the answer is a point-in-time copy.
   */
  isWorldDataStale(): boolean {
    return this.worldDataStale;
  }

  /**
   * Returns true if worldData is available (Socket.IO mode connected).
   */
  hasWorldData(): boolean {
    return this.worldData !== null;
  }

  // ==========================================================================
  // World data accessors
  // ==========================================================================

  /**
   * Re-emits 'world' on the existing socket to refresh the cached snapshot.
   *
   * Registers a one-shot 'world' listener and cleans it up on every exit
   * path (success, error, timeout) via `socket.off()` so that repeated
   * refreshes over a long-running session do not leak listener handles.
   */
  async refreshWorldData(): Promise<void> {
    if (!this.socket?.connected) {
      throw new Error('Not connected — cannot refresh world data');
    }

    this.worldData = await new Promise<WorldData>((resolve, reject) => {
      const cleanup = () => {
        this.socket?.off('world', onWorld);
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Refresh timeout'));
      }, this.config.timeout ?? 15000);

      const onWorld = (data: WorldData) => {
        cleanup();
        clearTimeout(timeoutId);
        try {
          const parsed = WorldDataSchema.safeParse(data);
          if (!parsed.success) {
            logger.warn('WorldData refresh failed schema validation — proceeding with raw data', {
              issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            });
          }
          resolve(data);
        } catch (err) {
          reject(err as Error);
        }
      };

      this.socket?.once('world', onWorld);
      this.socket?.emit('world');
    });

    this.worldDataStale = false;
    logger.info('World data refreshed', {
      actors: this.worldData.actors.length,
      items: this.worldData.items.length,
    });
  }

  getWorldData(): WorldData | null {
    return this.worldData;
  }

  // ==========================================================================
  // Actor methods
  // ==========================================================================

  async searchActors(params: SearchActorsParams): Promise<ActorSearchResult> {
    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        const response = await this.http.get('/api/actors', { params });
        return response.data;
      });
    }

    if (!this.worldData) {
      return { actors: [], total: 0, page: 1, limit: params.limit || 10 };
    }

    let results = this.worldData.actors;

    if (params.query) {
      const q = params.query.toLowerCase();
      results = results.filter((a) => a.name.toLowerCase().includes(q));
    }
    if (params.type) {
      const t = params.type.toLowerCase();
      results = results.filter((a) => a.type.toLowerCase() === t);
    }

    const total = results.length;
    const limit = params.limit || 10;
    const actors: FoundryActor[] = results.slice(0, limit).map(worldActorToFoundry);

    return { actors, total, page: 1, limit };
  }

  async getActor(actorId: string): Promise<FoundryActor> {
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        const response = await this.http.get(`/api/actors/${actorId}`);
        return response.data;
      });
    }

    if (!this.worldData) {
      throw new Error('Not connected — no world data available');
    }

    const actor = this.worldData.actors.find((a) => a._id === actorId);
    if (!actor) {
      throw new Error(`Actor not found: ${actorId}`);
    }

    return worldActorToFoundry(actor);
  }

  /**
   * Returns the raw WorldActor with the full system data (game-system specific).
   */
  getRawActor(actorId: string): WorldActor | undefined {
    return this.worldData?.actors.find((a) => a._id === actorId);
  }

  /**
   * Patches attributes on an actor's `system` object (#143). WRITE — Socket.IO.
   *
   * `patch` keys are dot-paths into `actor.system` (e.g. `attributes.hp.value`,
   * `currency.gp`, `spells.spell1.value`, `attributes.exhaustion`). Each key is
   * prefixed with `system.` and sent through the Socket.IO `modifyDocument`
   * write protocol as an `Actor` `update` — matching FoundryVTT's own document
   * model (`Actor#update`). No REST call and no `apiKey` are involved.
   *
   * Client-side validation, using the actor's current data, rejects:
   *  - HP value exceeding `max + temp`,
   *  - spell-slot value exceeding its `max`,
   *  - exhaustion outside `0–10` (2024 rules) or `0–6` (2014 rules).
   *
   * @throws via `assertWriteable()` if `writeEnabled` is false or the socket
   *   is not connected; also if the id is malformed, the actor/path is missing,
   *   or a validation rule is violated.
   */
  async updateActorAttribute(
    actorId: string,
    patch: AttributePatch,
  ): Promise<ActorAttributeUpdateResult> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (!isRecord(patch) || Object.keys(patch).length === 0) {
      throw new Error('patch is required and must contain at least one attribute path');
    }

    // Fetch current actor data to validate paths and bounds. getActor returns
    // the mapped actor in socket mode (no `system`), so fall back to the cached
    // raw actor for the system document the validator needs.
    const actor = await this.getActor(actorId);
    const rawSystem = systemOf(actor) ?? systemOf(this.getRawActor(actorId));
    validateAttributePatch(patch, actor, rawSystem);

    // The patch keys are dot-paths into `actor.system`; prefix each with
    // `system.` for the document update. FoundryVTT accepts dot-notation keys
    // in update objects and merges recursively.
    const update: Record<string, unknown> = { _id: actorId };
    for (const [path, value] of Object.entries(patch)) {
      update[`system.${path}`] = value;
    }
    const result = await this.modifyDocument('Actor', 'update', {
      updates: [update],
      diff: true,
      recursive: true,
    });

    // Echo the post-update value for each patched path. Prefer the server's
    // returned document when present; otherwise reflect the requested value.
    const returned = isRecord(result[0]) ? (result[0] as Record<string, unknown>) : undefined;
    const updatedAttributes: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(patch)) {
      const fromServer = returned ? getDotPath(returned, `system.${path}`) : undefined;
      updatedAttributes[path] = fromServer !== undefined ? fromServer : value;
    }

    return { success: true, updatedAttributes };
  }

  // ==========================================================================
  // Item methods
  // ==========================================================================

  async searchItems(params: SearchItemsParams): Promise<ItemSearchResult> {
    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        const response = await this.http.get('/api/items', { params });
        return response.data;
      });
    }

    if (!this.worldData) {
      return { items: [], total: 0, page: 1, limit: params.limit || 10 };
    }

    let results = this.worldData.items;

    if (params.query) {
      const q = params.query.toLowerCase();
      results = results.filter((i) => i.name.toLowerCase().includes(q));
    }
    if (params.type) {
      const t = params.type.toLowerCase();
      results = results.filter((i) => i.type.toLowerCase() === t);
    }

    const total = results.length;
    const limit = params.limit || 10;
    const items = results.slice(0, limit).map((i) => {
      const item: {
        _id: string;
        name: string;
        type: string;
        img?: string;
        description?: string;
        rarity?: string;
      } = {
        _id: i._id,
        name: i.name,
        type: i.type,
      };
      if (i.img) {
        item.img = i.img;
      }
      const desc = extractString(i.system, 'description', 'value');
      if (desc) {
        item.description = desc;
      }
      const rar = extractString(i.system, 'rarity');
      if (rar) {
        item.rarity = rar;
      }
      return item;
    });

    return { items, total, page: 1, limit };
  }

  // ==========================================================================
  // Compendium methods
  // ==========================================================================

  /**
   * Searches FoundryVTT compendium packs by name and metadata.
   *
   * Compendium data is not present in the cached worldData snapshot, so this
   * read requires the REST API module (FOUNDRY_API_KEY). When the key is
   * absent it returns a graceful empty result with `restAvailable: false`
   * rather than throwing, mirroring the no-worldData behaviour of
   * {@link searchItems}/{@link searchActors}; the handler surfaces a note
   * explaining why no results were returned.
   */
  async searchCompendium(params: CompendiumSearchParams): Promise<CompendiumSearchResult> {
    const limit = params.limit ?? 20;
    const offset = decodeCursor(params.cursor);

    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        // Translate the opaque cursor into a wire offset for the bridge.
        const { cursor: _cursor, ...rest } = params;
        const response = await this.http.get('/api/compendium/search', {
          params: { ...rest, limit, offset },
        });
        const data = (
          isRecord(response.data) ? response.data : {}
        ) as Partial<CompendiumSearchResult>;
        const results = data.results ?? [];
        const total = typeof data.total === 'number' ? data.total : results.length;
        const nextOffset = offset + results.length;
        return {
          results,
          total,
          page: Math.floor(offset / limit) + 1,
          limit,
          restAvailable: true,
          nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
        };
      });
    }
    return { results: [], total: 0, page: 1, limit, restAvailable: false, nextCursor: null };
  }

  // ==========================================================================
  // Write helpers (Socket.IO `modifyDocument` — primary transport, PRD-003)
  // ==========================================================================

  /**
   * Guards a write operation. Writes require the `FOUNDRY_WRITE_ENABLED` opt-in
   * and an active authenticated Socket.IO session (the primary transport).
   * Throws a clear, actionable error otherwise.
   */
  private assertWriteable(): void {
    if (!this.config.writeEnabled) {
      throw new Error(
        'Write operations are disabled. Set FOUNDRY_WRITE_ENABLED=true to allow game-state mutation.',
      );
    }
    if (!this.socket?.connected) {
      throw new Error(
        'Write operations require an active Socket.IO connection to FoundryVTT (username/password mode).',
      );
    }
  }

  /**
   * Emits a Socket.IO event with an acknowledgement callback, resolving the
   * server's response and rejecting on timeout. Mirrors the ack pattern used by
   * the `world` event in {@link connectAndLoadWorld}/{@link refreshWorldData}.
   */
  private emitWithAck<T>(event: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = this.socket;
      if (!socket?.connected) {
        reject(new Error('Socket.IO is not connected'));
        return;
      }
      const timeoutMs = this.config.timeout || 10000;
      const timeout = setTimeout(
        () => reject(new Error(`Timeout waiting for '${event}' response (${timeoutMs}ms)`)),
        timeoutMs,
      );
      socket.emit(event, payload, (response: T) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  }

  // ==========================================================================
  // Compendium listing (READ - socket world data / modifyDocument get)
  // ==========================================================================

  /** Lists compendium packs advertised in the socket `world` payload. */
  listCompendiums(): Array<{
    id: string;
    label: string;
    type: string;
    package: string;
    packageType: string;
    system: string | null;
  }> {
    const packs = (this.worldData?.packs ?? []) as Array<Record<string, unknown>>;
    return packs.map((p) => {
      const pkg = String(p.packageName ?? p.package ?? '');
      const name = String(p.name ?? '');
      const sys = p.system;
      return {
        id: String(p.id ?? (pkg && name ? `${pkg}.${name}` : name)),
        label: String(p.label ?? name),
        type: String(p.type ?? p.documentName ?? p.entity ?? ''),
        package: pkg,
        packageType: String(p.packageType ?? ''),
        system: Array.isArray(sys) ? sys.join(',') : sys ? String(sys) : null,
      };
    });
  }

  /** Reads the index (_id, name, type) of one compendium pack (read-only `get`). */
  async getCompendiumIndex(packId: string): Promise<{
    pack: string;
    documentName: string;
    entries: Array<{ _id: string; name: string; type: string | null }>;
  }> {
    const pack = this.listCompendiums().find((p) => p.id === packId);
    if (!pack) {
      throw new Error(`Unknown compendium pack: ${packId}`);
    }
    const request = {
      type: pack.type,
      action: 'get',
      operation: { query: {}, index: true, indexFields: ['_id', 'name', 'type'], pack: packId },
    };
    const response = await this.emitWithAck<DocumentSocketResponse>('modifyDocument', request);
    if (response?.error) {
      throw new Error(
        `FoundryVTT rejected index read for ${packId}: ${response.error.message || 'unknown error'}`,
      );
    }
    const rows = Array.isArray(response?.result)
      ? (response.result as Array<Record<string, unknown>>)
      : [];
    return {
      pack: packId,
      documentName: pack.type,
      entries: rows.map((r) => ({
        _id: String(r._id ?? ''),
        name: String(r.name ?? ''),
        type: r.type === undefined || r.type === null ? null : String(r.type),
      })),
    };
  }

  /**
   * Performs a FoundryVTT document mutation over Socket.IO using the core
   * `modifyDocument` protocol. The request shape is verified against the
   * v13.348 client source (`client/data/client-backend.mjs` `#buildRequest`,
   * `helpers/socket-interface.mjs` `dispatch`, `common/abstract/socket.mjs`).
   *
   * @param type - Document name ("Actor", "Item", …)
   * @param action - "create" | "update" | "delete"
   * @param operation - action-specific payload: `data` (create) / `updates`
   *   (update) / `ids` (delete), plus `parentUuid` for embedded documents.
   * @returns the server's `result` array (created/updated data, or deleted ids)
   */
  private async modifyDocument(
    type: string,
    action: 'create' | 'update' | 'delete',
    operation: Record<string, unknown>,
  ): Promise<unknown[]> {
    const request = {
      type,
      action,
      operation: { broadcast: true, pack: null, modifiedTime: Date.now(), ...operation },
    };
    const response = await this.emitWithAck<DocumentSocketResponse>('modifyDocument', request);
    if (response?.error) {
      throw new Error(
        `FoundryVTT rejected ${action} ${type}: ${response.error.message || 'unknown error'}`,
      );
    }
    return Array.isArray(response?.result) ? response.result : [];
  }

  // ==========================================================================
  // GM toolkit primitives (generic document access + allow-listed socket events)
  // ==========================================================================

  /** Live (cached) world payload, or null before the first world load. */
  getWorld(): WorldData | null {
    return this.worldData;
  }

  /** Scene id each user last reported viewing (from `userActivity`), if seen. */
  getViewedScene(userId: string): string | undefined {
    return this.viewedScenes.get(userId);
  }

  /**
   * Wait until each of `userIds` reports viewing `sceneId`, or the timeout
   * passes. Users without an open client never report, so callers should
   * treat a missing confirmation as "not seen", not as a failure.
   *
   * @returns the user ids that confirmed
   */
  waitForViewedScene(userIds: string[], sceneId: string, timeoutMs: number): Promise<string[]> {
    const confirmed = () => userIds.filter((id) => this.viewedScenes.get(id) === sceneId);
    return new Promise((resolve) => {
      const check = () => {
        if (confirmed().length === userIds.length) {
          finish();
        }
      };
      const finish = () => {
        clearTimeout(timer);
        this.viewedSceneWaiters.delete(check);
        resolve(confirmed());
      };
      const timer = setTimeout(finish, timeoutMs);
      this.viewedSceneWaiters.add(check);
      check();
    });
  }

  /** Whether FOUNDRY_WRITE_ENABLED is set. */
  isWriteEnabled(): boolean {
    return Boolean(this.config.writeEnabled);
  }

  /**
   * Update tokens on a scene. Position changes (x, y, elevation, size, level)
   * are sent as a movement, with the `_movement` record and full position
   * that browser clients send, so they are applied live on every connected
   * client; other fields are sent as a normal diff update.
   *
   * @param waypoints Optional intermediate top-left positions per token id.
   */
  async updateTokens(
    sceneId: string,
    updates: Array<Record<string, unknown>>,
    waypoints: Record<string, Array<{ x: number; y: number }>> = {},
  ): Promise<unknown[]> {
    const parentUuid = `Scene.${sceneId}`;
    const scene = this.getWorld()?.scenes.find((s) => s._id === sceneId) as
      | (Record<string, unknown> & { tokens?: Array<Record<string, unknown>> })
      | undefined;
    const grid = scene?.grid as Record<string, unknown> | number | undefined;
    const gridSize = Number((typeof grid === 'object' ? grid?.size : grid) ?? 100);
    const gridDistance = Number((typeof grid === 'object' ? grid?.distance : undefined) ?? 1);
    const plain: Array<Record<string, unknown>> = [];
    const moves: Array<Record<string, unknown>> = [];
    const movement: Record<string, unknown> = {};
    for (const u of updates) {
      const token = scene?.tokens?.find((t) => t._id === u._id);
      if (!token || !isMovementUpdate(u)) {
        plain.push(u);
        continue;
      }
      const { update, movement: m } = buildTokenMovement(token, u, this.getWorld()?.userId, {
        gridSize,
        gridDistance,
        waypoints: waypoints[String(u._id)] ?? [],
      });
      moves.push(update);
      movement[String(u._id)] = m;
    }
    const out: unknown[] = [];
    if (plain.length) {
      out.push(
        ...(await this.gmModify('Token', 'update', { updates: plain, parentUuid, diff: true })),
      );
    }
    if (moves.length) {
      out.push(
        ...(await this.gmModify('Token', 'update', {
          updates: moves,
          parentUuid,
          diff: false,
          recursive: true,
          _movement: movement,
        })),
      );
    }
    return out;
  }

  /**
   * Generic WRITE through `modifyDocument`, gated by FOUNDRY_WRITE_ENABLED.
   * Foundry acks the requester but only broadcasts to *other* sockets, so the
   * result is applied to the world cache here to keep reads consistent.
   */
  async gmModify(
    type: string,
    action: 'create' | 'update' | 'delete',
    operation: Record<string, unknown>,
  ): Promise<unknown[]> {
    this.assertWriteable();
    const result = await this.modifyDocument(type, action, operation);
    if (this.worldData && result.length) {
      try {
        const parentUuid =
          typeof operation.parentUuid === 'string' ? operation.parentUuid : undefined;
        applyDocumentBroadcast(this.worldData, {
          type,
          action,
          result: result as never,
          ...(parentUuid ? { parentUuid } : {}),
        } as never);
      } catch (err) {
        logger.debug('gmModify: cache apply failed', { type, action, err: String(err) });
      }
    }
    return result;
  }

  /** Generic READ (`modifyDocument` action `get`); never mutates. */
  async gmGet(type: string, operation: Record<string, unknown>): Promise<unknown[]> {
    const response = await this.emitWithAck<DocumentSocketResponse>('modifyDocument', {
      type,
      action: 'get',
      operation: { query: {}, ...operation },
    });
    if (response?.error) {
      throw new Error(`FoundryVTT rejected get ${type}: ${response.error.message || 'unknown'}`);
    }
    return Array.isArray(response?.result) ? response.result : [];
  }

  /**
   * Emits one of a fixed allow-list of GM socket events (no arbitrary events,
   * no code evaluation). Events the server acks are awaited; the rest are
   * fire-and-forget: only `showEntry` takes an acknowledgement callback in v14.
   * Always write-gated, since every one is visible to players.
   */
  async gmEmit(
    event: 'pullToScene' | 'resetFog' | 'shareImage' | 'showEntry',
    ...args: unknown[]
  ): Promise<unknown> {
    this.assertWriteable();
    const socket = this.socket as Socket;
    if (event === 'showEntry') {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Timeout waiting for showEntry')), 10000);
        socket.emit(event, ...args, (r: unknown) => {
          clearTimeout(t);
          resolve(r);
        });
      });
    }
    socket.emit(event, ...args);
    return true;
  }

  // ==========================================================================
  // Item mutation methods (WRITE — Socket.IO modifyDocument)
  // ==========================================================================

  /**
   * Creates a new item on an actor via the `modifyDocument` socket protocol.
   *
   * Inline sources are created directly. Compendium sources are NOT yet
   * supported over Socket.IO — copying a pack entry needs a compendium read
   * that `modifyDocument` does not provide (tracked in issue #159).
   *
   * @param actorId - 16-char alphanumeric actor document id
   * @param source - inline item document (compendium source throws)
   * @returns the newly created item document
   */
  async createActorItem(actorId: string, source: ActorItemCreateSource): Promise<FoundryItem> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (source.type === 'compendium') {
      throw new Error(
        'Creating an item from a compendium source is not yet supported over Socket.IO; ' +
          'provide an inline item instead. See issue #159.',
      );
    }
    const result = await this.modifyDocument('Item', 'create', {
      data: [source.item],
      parentUuid: `Actor.${actorId}`,
    });
    return result[0] as FoundryItem;
  }

  /**
   * Applies a JSON merge patch to an item owned by an actor.
   *
   * The `patch` is merged into the item's `system` data (recursively, so nested
   * paths like the D&D 5e v4+ `activities.{id}.consumption.targets` are
   * preserved). Performed via the `modifyDocument` socket protocol.
   *
   * @param actorId - 16-char alphanumeric actor document id
   * @param itemId - 16-char alphanumeric item document id
   * @param patch - shallow/nested JSON merge patch applied to `item.system`
   * @returns the updated item document
   */
  async updateActorItem(
    actorId: string,
    itemId: string,
    patch: Record<string, unknown>,
  ): Promise<FoundryItem> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(itemId)) {
      throw new Error(`Invalid itemId format: ${itemId}`);
    }
    const result = await this.modifyDocument('Item', 'update', {
      updates: [{ _id: itemId, system: patch }],
      parentUuid: `Actor.${actorId}`,
      diff: true,
      recursive: true,
    });
    return result[0] as FoundryItem;
  }

  /**
   * Deletes an item owned by an actor via the `modifyDocument` socket protocol.
   *
   * @param actorId - 16-char alphanumeric actor document id
   * @param itemId - 16-char alphanumeric item document id
   */
  async deleteActorItem(actorId: string, itemId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(itemId)) {
      throw new Error(`Invalid itemId format: ${itemId}`);
    }
    await this.modifyDocument('Item', 'delete', {
      ids: [itemId],
      parentUuid: `Actor.${actorId}`,
    });
  }

  // ==========================================================================
  // Combat mutation methods (WRITE — Socket.IO modifyDocument, FR-018)
  // ==========================================================================

  /**
   * Updates the active combat's turn/round pointers (FR-018).
   *
   * `Combat` is a top-level document, so the update carries no `parentUuid`.
   * The patch fields map directly onto the Combat document (`turn`, `round`).
   *
   * @param combatId - 16-char alphanumeric Combat document id
   * @param patch - turn and/or round to set on the combat
   * @returns the updated combat document
   */
  async updateCombat(combatId: string, patch: { turn?: number; round?: number }): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(combatId)) {
      throw new Error(`Invalid combatId format: ${combatId}`);
    }
    const result = await this.modifyDocument('Combat', 'update', {
      updates: [{ _id: combatId, ...patch }],
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  /**
   * Ends (deletes) the active combat encounter (FR-018).
   *
   * @param combatId - 16-char alphanumeric Combat document id
   */
  async endCombat(combatId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(combatId)) {
      throw new Error(`Invalid combatId format: ${combatId}`);
    }
    await this.modifyDocument('Combat', 'delete', { ids: [combatId] });
  }

  /**
   * Sets a combatant's initiative (FR-018).
   *
   * `Combatant` is an embedded document inside `Combat`, so the update is sent
   * with `parentUuid: "Combat.<combatId>"`.
   *
   * @param combatId - 16-char alphanumeric Combat document id (the parent)
   * @param combatantId - 16-char alphanumeric Combatant document id
   * @param initiative - finite initiative value to assign
   * @returns the updated combatant document
   */
  async setCombatantInitiative(
    combatId: string,
    combatantId: string,
    initiative: number,
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(combatId)) {
      throw new Error(`Invalid combatId format: ${combatId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(combatantId)) {
      throw new Error(`Invalid combatantId format: ${combatantId}`);
    }
    if (typeof initiative !== 'number' || !Number.isFinite(initiative)) {
      throw new Error(`Invalid initiative: ${initiative} (must be a finite number)`);
    }
    const result = await this.modifyDocument('Combatant', 'update', {
      updates: [{ _id: combatantId, initiative }],
      parentUuid: `Combat.${combatId}`,
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  /**
   * Starts a new combat encounter and seeds its combatants (FR-018, #172).
   *
   * Two-step `modifyDocument` flow:
   *   1. Create the top-level `Combat` document (no `parentUuid`), activated on
   *      the given scene, and read its `_id` from the response.
   *   2. Create the embedded `Combatant` documents with
   *      `parentUuid: "Combat.<combatId>"` (mirrors the Combatant→Combat embed
   *      used by {@link setCombatantInitiative}).
   *
   * The create wire shape is verified against the v13.348 client source per
   * `.claude/rules/foundry-write-protocol.md`; smoke-test one live round-trip
   * when changing it.
   *
   * @param sceneId - 16-char alphanumeric Scene document id the combat runs on
   * @param combatants - combatant seeds ({ tokenId, sceneId, actorId? })
   * @returns the new combat id and the number of combatants created
   */
  async startCombat(
    sceneId: string,
    combatants: Array<{ tokenId: string; sceneId: string; actorId?: string | undefined }>,
  ): Promise<{ combatId: string; combatantCount: number }> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    for (const c of combatants) {
      if (!FOUNDRY_ID_PATTERN.test(c.tokenId)) {
        throw new Error(`Invalid tokenId format: ${c.tokenId}`);
      }
    }

    const created = await this.modifyDocument('Combat', 'create', {
      data: [{ scene: sceneId, active: true }],
    });
    const combat = created[0] as { _id?: string } | undefined;
    const combatId = combat?._id;
    if (!combatId) {
      throw new Error('FoundryVTT did not return a Combat id after create');
    }

    if (combatants.length > 0) {
      await this.modifyDocument('Combatant', 'create', {
        data: combatants,
        parentUuid: `Combat.${combatId}`,
      });
    }

    return { combatId, combatantCount: combatants.length };
  }

  // ==========================================================================
  // Token mutation methods (WRITE — Socket.IO modifyDocument, FR-019)
  // ==========================================================================

  /**
   * Locates a token (and the scene it lives on) in the cached worldData.
   *
   * `Token` is an embedded document of `Scene`; worldData carries each scene's
   * tokens as raw records. When `sceneId` is omitted the search spans every
   * scene, so a token can be moved/affected without first resolving its scene.
   *
   * @param tokenId - 16-char alphanumeric Token document id
   * @param sceneId - optional Scene id to scope the search to
   * @returns the owning scene and the raw token record, or null if not found
   */
  findToken(
    tokenId: string,
    sceneId?: string,
  ): { scene: WorldScene; token: Record<string, unknown> } | null {
    if (!this.worldData) {
      return null;
    }
    const scenes = sceneId
      ? this.worldData.scenes.filter((s) => s._id === sceneId)
      : this.worldData.scenes;
    for (const scene of scenes) {
      const token = scene.tokens?.find((t) => (t as { _id?: string })._id === tokenId);
      if (token) {
        return { scene, token };
      }
    }
    return null;
  }

  /**
   * Moves a token to new x/y coordinates (FR-019).
   *
   * `Token` is an embedded document of `Scene`, so the update is sent with
   * `parentUuid: "Scene.<sceneId>"` (mirrors the Combatant→Combat embed). The
   * wire shape is verified against the v13.348 client source per
   * `.claude/rules/foundry-write-protocol.md`.
   *
   * @param sceneId - 16-char alphanumeric Scene document id (the parent)
   * @param tokenId - 16-char alphanumeric Token document id
   * @param x - target x pixel coordinate (finite number)
   * @param y - target y pixel coordinate (finite number)
   * @returns the updated token document
   */
  async moveToken(sceneId: string, tokenId: string, x: number, y: number): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(tokenId)) {
      throw new Error(`Invalid tokenId format: ${tokenId}`);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid coordinates: (${x}, ${y}) — x and y must be finite numbers`);
    }
    const result = await this.updateTokens(sceneId, [{ _id: tokenId, x, y }]);
    return result[0];
  }

  /** Parent UUID to send for an effect on a token's actor (see {@link effectParentUuid}). */
  private effectParent(parentActorUuid: string): string {
    return effectParentUuid(parentActorUuid, (sid, tid) => {
      const scene = this.worldData?.scenes.find((x) => x._id === sid) as
        | { tokens?: Array<Record<string, unknown>> }
        | undefined;
      return scene?.tokens?.find((t) => t._id === tid);
    });
  }

  /**
   * Creates a status-effect `ActiveEffect` on a token's actor (FR-019).
   *
   * `ActiveEffect` is an embedded document of `Actor`, so the create is sent with
   * the actor's parent UUID:
   *  - `Actor.<id>` for a world-linked actor (`actorLink: true`)
   *  - `Scene.<sid>.Token.<tid>.Actor.<aid>` for an unlinked token's synthetic
   *    actor (the per-token delta).
   *
   * The effect carries a `statuses` array, matching how FoundryVTT v11+ models
   * conditions (`Actor#toggleStatusEffect` toggles by this field).
   *
   * @param parentActorUuid - the token actor's parent UUID (see forms above)
   * @param statusId - condition id (e.g. "prone", "stunned")
   * @param options - optional display `name` (defaults to `statusId`) and `img`
   * @returns the newly created ActiveEffect document
   */
  async createActorStatusEffect(
    parentActorUuid: string,
    statusId: string,
    options: { name?: string; img?: string } = {},
  ): Promise<WorldEffect> {
    this.assertWriteable();
    if (!TOKEN_ACTOR_UUID_PATTERN.test(parentActorUuid)) {
      throw new Error(`Invalid actor UUID format: ${parentActorUuid}`);
    }
    if (!statusId || typeof statusId !== 'string') {
      throw new Error('statusId is required and must be a string');
    }
    const effectData: Record<string, unknown> = {
      name: options.name ?? statusId,
      statuses: [statusId],
    };
    if (options.img) {
      effectData.img = options.img;
    }
    const result = await this.modifyDocument('ActiveEffect', 'create', {
      data: [effectData],
      parentUuid: this.effectParent(parentActorUuid),
    });
    return result[0] as WorldEffect;
  }

  /**
   * Deletes an `ActiveEffect` from a token's actor (FR-019), e.g. to clear a
   * status condition. Accepts the same parent-UUID forms as
   * {@link createActorStatusEffect}.
   *
   * @param parentActorUuid - the token actor's parent UUID
   * @param effectId - 16-char alphanumeric ActiveEffect document id
   */
  async deleteActorEffect(parentActorUuid: string, effectId: string): Promise<void> {
    this.assertWriteable();
    if (!TOKEN_ACTOR_UUID_PATTERN.test(parentActorUuid)) {
      throw new Error(`Invalid actor UUID format: ${parentActorUuid}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(effectId)) {
      throw new Error(`Invalid effectId format: ${effectId}`);
    }
    await this.modifyDocument('ActiveEffect', 'delete', {
      ids: [effectId],
      parentUuid: this.effectParent(parentActorUuid),
    });
  }

  // ==========================================================================
  // Scene methods
  // ==========================================================================

  async getCurrentScene(sceneId?: string): Promise<FoundryScene> {
    if (sceneId !== undefined && !FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        const endpoint = sceneId ? `/api/scenes/${sceneId}` : '/api/scenes/current';
        const response = await this.http.get(endpoint);
        return response.data;
      });
    }

    if (!this.worldData) {
      throw new Error('Not connected — no world data available');
    }

    let scene: WorldScene | undefined;
    if (sceneId) {
      scene = this.worldData.scenes.find((s) => s._id === sceneId);
    } else {
      scene = this.worldData.scenes.find((s) => s.active);
    }

    if (!scene) {
      throw new Error(sceneId ? `Scene not found: ${sceneId}` : 'No active scene');
    }

    return worldSceneToFoundry(scene);
  }

  async getScene(sceneId: string): Promise<FoundryScene> {
    return this.getCurrentScene(sceneId);
  }

  getScenes(): WorldScene[] {
    return this.worldData?.scenes || [];
  }

  // ==========================================================================
  // World info
  // ==========================================================================

  async getWorldInfo(): Promise<FoundryWorld> {
    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        const response = await this.http.get('/api/world');
        return response.data;
      });
    }

    if (!this.worldData) {
      return {
        id: 'unknown',
        title: 'Not connected',
        description: 'Connect to FoundryVTT to retrieve world information',
        system: 'unknown',
        coreVersion: 'unknown',
        systemVersion: 'unknown',
        playtime: 0,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
      };
    }

    const w = this.worldData.world as Record<string, unknown>;
    const s = this.worldData.system as Record<string, unknown>;
    const r = this.worldData.release as Record<string, unknown>;

    return {
      id: (w.id as string) || 'unknown',
      title: (w.title as string) || 'Unknown World',
      description: (w.description as string) || '',
      system: (s.id as string) || 'unknown',
      coreVersion: (r.version as string) || (r.generation as string) || 'unknown',
      systemVersion: (s.version as string) || 'unknown',
      playtime: 0,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
    };
  }

  // ==========================================================================
  // Combat
  // ==========================================================================

  getCombatState(): WorldCombat | null {
    if (!this.worldData) {
      return null;
    }
    return this.worldData.combats.find((c) => c.active) ?? null;
  }

  // ==========================================================================
  // Chat messages
  // ==========================================================================

  getChatMessages(limit = 20): WorldMessage[] {
    if (!this.worldData) {
      return [];
    }
    return this.worldData.messages.slice(-limit);
  }

  // ==========================================================================
  // Users
  // ==========================================================================

  getUsers(): { users: WorldUser[]; activeUsers: string[] } {
    if (!this.worldData) {
      return { users: [], activeUsers: [] };
    }
    return {
      users: this.worldData.users,
      activeUsers: this.worldData.activeUsers,
    };
  }

  // ==========================================================================
  // Journals
  // ==========================================================================

  getJournals(): WorldJournal[] {
    return this.worldData?.journal || [];
  }

  searchJournals(query: string): WorldJournal[] {
    if (!this.worldData) {
      return [];
    }
    const q = query.toLowerCase();
    return this.worldData.journal.filter((j) => {
      if (j.name.toLowerCase().includes(q)) {
        return true;
      }
      return j.pages?.some(
        (p) => p.name.toLowerCase().includes(q) || p.text?.content?.toLowerCase().includes(q),
      );
    });
  }

  getJournal(journalId: string): WorldJournal | undefined {
    return this.worldData?.journal.find((j) => j._id === journalId);
  }

  // ==========================================================================
  // Journal mutation methods (WRITE — Socket.IO modifyDocument)
  // ==========================================================================

  /**
   * Creates a new JournalEntry with one or more text pages.
   *
   * `JournalEntry` is a top-level document (unlike Item/ActiveEffect, which
   * are embedded in an Actor), so the create carries no `parentUuid` —
   * mirrors {@link startCombat}'s top-level Combat create. Each entry in
   * `pages` is mapped to Foundry's native `JournalEntryPage` text-page shape,
   * with an explicit `sort` so the pages render in the order supplied.
   *
   * @param name - journal entry title
   * @param pages - one or more pages (name + content); at least one required
   * @param folder - optional 16-char Folder document id to file the entry under
   * @param visibility - who can see the entry (#204); omitted means GM-only,
   *   which is FoundryVTT's default for a newly created document
   * @returns the newly created journal entry document
   */
  async createJournalEntry(
    name: string,
    pages: JournalPageCreateSource[],
    folder?: string,
    visibility?: DocumentVisibility,
  ): Promise<WorldJournal> {
    this.assertWriteable();
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a string');
    }
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error('pages is required and must contain at least one page');
    }
    if (folder !== undefined && !FOUNDRY_ID_PATTERN.test(folder)) {
      throw new Error(`Invalid folder format: ${folder}`);
    }
    if (visibility !== undefined && !(visibility in VISIBILITY_LEVELS)) {
      throw new Error(
        `Invalid visibility: ${visibility}. Expected one of: ${Object.keys(VISIBILITY_LEVELS).join(', ')}`,
      );
    }

    const data: Record<string, unknown> = {
      name,
      pages: pages.map((p, i) => ({
        name: p.name,
        type: 'text',
        text: { content: p.content, format: 1 },
        sort: (i + 1) * SORT_INTEGER_DENSITY,
      })),
    };
    if (folder) {
      data.folder = folder;
    }
    if (visibility) {
      data.ownership = { default: VISIBILITY_LEVELS[visibility] };
    }

    const result = await this.modifyDocument('JournalEntry', 'create', {
      data: [data],
    });
    return result[0] as WorldJournal;
  }

  // ==========================================================================
  // Cross-collection search
  // ==========================================================================

  searchWorld(query: string): {
    actors: WorldActor[];
    items: WorldItem[];
    scenes: WorldScene[];
    journals: WorldJournal[];
  } {
    if (!this.worldData) {
      return { actors: [], items: [], scenes: [], journals: [] };
    }

    const q = query.toLowerCase();

    return {
      actors: this.worldData.actors.filter((a) => a.name.toLowerCase().includes(q)),
      items: this.worldData.items.filter((i) => i.name.toLowerCase().includes(q)),
      scenes: this.worldData.scenes.filter((s) => s.name.toLowerCase().includes(q)),
      journals: this.worldData.journal.filter((j) => j.name.toLowerCase().includes(q)),
    };
  }

  // ==========================================================================
  // World summary
  // ==========================================================================

  getWorldSummary(): Record<string, number> {
    if (!this.worldData) {
      return {};
    }
    return {
      actors: this.worldData.actors.length,
      items: this.worldData.items.length,
      scenes: this.worldData.scenes.length,
      journals: this.worldData.journal.length,
      combats: this.worldData.combats.length,
      users: this.worldData.users.length,
      messages: this.worldData.messages.length,
      macros: this.worldData.macros.length,
      playlists: this.worldData.playlists.length,
      tables: this.worldData.tables.length,
      folders: this.worldData.folders.length,
    };
  }

  // ==========================================================================
  // Dice rolling
  // ==========================================================================

  /**
   * Rolls a dice formula.
   *
   * Validation is deliberately **per transport**, because the two transports
   * are not equally capable (#219):
   *
   *  - **REST (`FOUNDRY_API_KEY`)** posts the formula to `/api/dice/roll`,
   *    where FoundryVTT's own `Roll` engine evaluates it. That engine
   *    understands more than this module does — parentheses, for one — so only
   *    the `DICE_FORMULA_ALPHABET` check applies here. Imposing the local
   *    parser's narrower grammar would take away a capability the transport
   *    has. What the alphabet does refuse is refused by name and position
   *    (`unexpected "k" at position 3`, via `alphabetViolation`), so the
   *    two transports are equally specific about what they would not evaluate.
   *  - **Socket.IO / no API key** has no remote evaluator: `fallbackDiceRoll`
   *    is the roller, so the grammar its parser can represent is the grammar
   *    accepted, and that parser is the *only* gate. No alphabet pre-check runs
   *    ahead of it, so its specific message (`unexpected "k" at position 3`)
   *    reaches the caller instead of a generic `Invalid dice formula: 4d6kh3`.
   *    Nothing is ever dropped from a total in silence.
   *
   * The length cap is common to both. A REST roll that cannot reach FoundryVTT
   * falls through to the local roller, which then applies the strict grammar —
   * a formula only Foundry could evaluate errors out rather than being
   * mis-totalled locally.
   */
  async rollDice(formula: string, reason?: string): Promise<DiceRoll> {
    if (typeof formula !== 'string' || formula.length > MAX_DICE_FORMULA_LENGTH) {
      throw new Error(`Invalid dice formula: ${formula}`);
    }

    if (this.config.apiKey) {
      if (!formula || !DICE_FORMULA_ALPHABET.test(formula)) {
        throw alphabetViolation(formula);
      }

      try {
        const response = await this.http.post('/api/dice/roll', {
          formula,
          flavor: reason,
        });

        const rolled = RestDiceRollSchema.parse(response.data);

        const result: DiceRoll = {
          formula,
          total: rolled.total,
          breakdown: rolled.terms?.map((term) => term.results?.join(', ')).join(' + ') || formula,
          timestamp: new Date().toISOString(),
        };
        if (reason) {
          result.reason = reason;
        }
        return result;
      } catch {
        // Fall through to local roll
      }
    }

    return this.fallbackDiceRoll(formula, reason);
  }

  /**
   * Rolls locally, when FoundryVTT is not doing it for us.
   *
   * Delegates the whole formula to {@link evaluateDiceFormula}, which consumes
   * the input end to end and throws on any leftover it cannot represent (#219).
   */
  private fallbackDiceRoll(formula: string, reason?: string): DiceRoll {
    const { total, breakdown } = evaluateDiceFormula(formula);

    const result: DiceRoll = {
      formula,
      total,
      breakdown,
      timestamp: new Date().toISOString(),
    };
    if (reason) {
      result.reason = reason;
    }
    return result;
  }

  // ==========================================================================
  // Connection test
  // ==========================================================================

  async testConnection(): Promise<boolean> {
    try {
      if (this.config.username && this.config.password) {
        await this.connect();
        return true;
      }

      const response = await this.http.get('/');
      logger.debug('Connection test successful', { status: response.status });
      return true;
    } catch (error) {
      logger.error('Failed to connect to FoundryVTT:', error);
      throw error;
    }
  }

  // ==========================================================================
  // HTTP helpers (preserved for REST API mode and diagnostics)
  // ==========================================================================

  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    const maxAttempts = (this.config.retryAttempts || 3) + 1;
    const baseDelay = this.config.retryDelay || 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          if (status && status >= 400 && status < 500 && status !== 429) {
            throw lastError;
          }
        }

        if (attempt === maxAttempts) {
          throw lastError;
        }

        const exponentialDelay = baseDelay * 2 ** (attempt - 1);
        const jitter = Math.random() * 0.1 * exponentialDelay;
        await new Promise((resolve) => setTimeout(resolve, exponentialDelay + jitter));
      }
    }

    throw lastError || new Error('Request failed after all retry attempts');
  }

  async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.executeWithRetry(() => this.http.get(url, config));
  }

  async post<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.executeWithRetry(() => this.http.post(url, data, config));
  }

  async put<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.executeWithRetry(() => this.http.put(url, data, config));
  }

  async delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.executeWithRetry(() => this.http.delete(url, config));
  }
}

// ============================================================================
// Mapping helpers — WorldData raw documents → display interfaces
// ============================================================================

function worldActorToFoundry(a: WorldActor): FoundryActor {
  const sys = a.system || {};
  const hpRaw = extractNested(sys, 'attributes', 'hp');
  const hp = isRecord(hpRaw) ? hpRaw : undefined;
  const acRaw = extractNested(sys, 'attributes', 'ac');
  const ac = isRecord(acRaw) ? acRaw : undefined;
  const details = isRecord(sys.details) ? sys.details : {};

  const abilitiesRaw = sys.abilities;
  let mappedAbilities: FoundryActor['abilities'];
  if (isRecord(abilitiesRaw)) {
    mappedAbilities = {};
    for (const [key, val] of Object.entries(abilitiesRaw)) {
      if (isRecord(val)) {
        const entry: { value: number; mod: number; save?: number } = {
          value: typeof val.value === 'number' ? val.value : 10,
          mod: typeof val.mod === 'number' ? val.mod : 0,
        };
        if (typeof val.save === 'number') {
          entry.save = val.save;
        }
        mappedAbilities[key] = entry;
      }
    }
  }

  const actor: FoundryActor = {
    _id: a._id,
    name: a.name,
    type: a.type,
  };

  if (a.img) {
    actor.img = a.img;
  }

  if (hp) {
    const hpValue = typeof hp.value === 'number' ? hp.value : 0;
    const hpMax = typeof hp.max === 'number' ? hp.max : 0;
    const hpObj: { value: number; max: number; temp?: number } = { value: hpValue, max: hpMax };
    if (typeof hp.temp === 'number') {
      hpObj.temp = hp.temp;
    }
    actor.hp = hpObj;
  }

  if (ac && typeof ac.value === 'number') {
    actor.ac = { value: ac.value };
  }

  if (typeof details.level === 'number') {
    actor.level = details.level;
  }

  if (mappedAbilities) {
    actor.abilities = mappedAbilities;
  }

  const bio = extractString(details, 'biography', 'value') || extractString(details, 'biography');
  if (bio) {
    actor.biography = bio;
  }

  return actor;
}

/**
 * Scene darkness in 0..1. Since v12 the value lives at
 * `environment.darknessLevel`; the top-level `darkness` field is absent, which
 * previously rendered as "NaN%".
 */
export function sceneDarkness(s: Record<string, unknown> | WorldScene): number {
  const env = (s as { environment?: { darknessLevel?: unknown } }).environment;
  const v = env?.darknessLevel ?? (s as { darkness?: unknown }).darkness;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Global illumination flag; v12+ stores it at `environment.globalLight.enabled`. */
export function sceneGlobalLight(s: Record<string, unknown> | WorldScene): boolean {
  const env = (s as { environment?: { globalLight?: { enabled?: unknown } } }).environment;
  const v = env?.globalLight?.enabled ?? (s as { globalLight?: unknown }).globalLight;
  return Boolean(v);
}

function worldSceneToFoundry(s: WorldScene): FoundryScene {
  const scene: FoundryScene = {
    _id: s._id,
    name: s.name,
    active: s.active,
    navigation: s.navigation,
    width: s.width,
    height: s.height,
    padding: s.padding,
    shiftX: 0,
    shiftY: 0,
    globalLight: sceneGlobalLight(s),
    darkness: sceneDarkness(s),
  };
  if (s.img) {
    scene.img = s.img;
  }
  const desc = (s.flags as Record<string, unknown>)?.description;
  if (typeof desc === 'string') {
    scene.description = desc;
  }
  return scene;
}

/**
 * Safely extracts a nested value from a Record tree.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Returns the `system` object of an actor-like document, accepting either the
 * raw REST/world document (`{ ..., system }`) or a cached {@link WorldActor}.
 * Returns undefined when no system object is present (e.g. the mapped
 * {@link FoundryActor} produced by the socket world-cache path).
 */
function systemOf(obj: unknown): Record<string, unknown> | undefined {
  if (isRecord(obj) && isRecord(obj.system)) {
    return obj.system;
  }
  return undefined;
}

/**
 * Compendium pagination cursors are opaque base64-encoded result offsets.
 * `encodeCursor` turns an offset into a cursor; `decodeCursor` reads it back,
 * returning 0 when the cursor is absent or malformed.
 */
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const decoded = Number.parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
  return Number.isFinite(decoded) && decoded >= 0 ? decoded : 0;
}

function extractNested(obj: Record<string, unknown>, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (isRecord(current) && key in current) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Extracts a string from nested Record, following a chain of keys.
 */
function extractString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  const val = extractNested(obj, ...keys);
  return typeof val === 'string' ? val : null;
}

// ============================================================================
// Attribute-patch helpers (#143)
// ============================================================================

/**
 * Reads a dot-path out of a nested Record tree, returning undefined if any
 * segment is missing.
 */
function getDotPath(obj: Record<string, unknown>, path: string): unknown {
  return extractNested(obj, ...path.split('.'));
}

/**
 * Reads the actor's game-system id from raw world data, when available.
 * Used to pick the exhaustion clamp (2024 dnd5e: 0–10; 2014: 0–6).
 */
function exhaustionMax(sys: Record<string, unknown> | undefined): number {
  // dnd5e 2024 rules cap exhaustion at 10; the 2014 rules cap it at 6.
  // Without an explicit rules-version signal, default to the wider 2024 range
  // so legitimate 2024 values are not rejected; the 2014 cap is applied when
  // the actor's system data exposes a `rules: "2014"`-style marker.
  if (isRecord(sys)) {
    const source = isRecord(sys._source) ? sys._source : undefined;
    const rules =
      extractString(sys, 'rules') ||
      (source ? extractString(source, 'rules') : null) ||
      extractString(sys, 'attributes', 'exhaustion', 'rules');
    if (rules === '2014' || rules === 'legacy') {
      return 6;
    }
  }
  return 10;
}

/**
 * Validates an attribute patch against the actor's current data, throwing a
 * clear error on the first violation. Only checks rules for which the needed
 * limit (max HP, slot max, exhaustion bound) is available.
 */
function validateAttributePatch(
  patch: AttributePatch,
  actor: FoundryActor,
  rawSystem: Record<string, unknown> | undefined,
): void {
  // Prefer the raw `system` document for bounds: in REST mode getActor returns
  // the raw document (HP at system.attributes.hp.{value,max,temp}); the mapped
  // FoundryActor.hp is only populated on the socket world-cache path.
  const rawHp = rawSystem ? extractNested(rawSystem, 'attributes', 'hp') : undefined;
  const hp = isRecord(rawHp) ? rawHp : undefined;

  for (const [path, value] of Object.entries(patch)) {
    // HP value cannot exceed max + temp.
    if (path === 'attributes.hp.value' && typeof value === 'number') {
      const patchedTemp = patch['attributes.hp.temp'];
      const currentTemp = typeof hp?.temp === 'number' ? hp.temp : (actor.hp?.temp ?? 0);
      const temp = typeof patchedTemp === 'number' ? patchedTemp : currentTemp;
      const max = typeof hp?.max === 'number' ? hp.max : actor.hp?.max;
      if (typeof max === 'number' && value > max + temp) {
        throw new Error(
          `Invalid HP value ${value}: exceeds max + temp (${max} + ${temp} = ${max + temp})`,
        );
      }
    }

    // Spell-slot value cannot exceed its max.
    const slotMatch = /^spells\.(spell\w+|pact)\.value$/.exec(path);
    const slotKey = slotMatch?.[1];
    if (slotKey && typeof value === 'number' && rawSystem) {
      const slotMax = extractNested(rawSystem, 'spells', slotKey, 'max');
      if (typeof slotMax === 'number' && value > slotMax) {
        throw new Error(
          `Invalid spell slot value ${value} for ${slotKey}: exceeds max (${slotMax})`,
        );
      }
    }

    // Exhaustion clamped 0–10 (2024) or 0–6 (2014).
    if (path === 'attributes.exhaustion' && typeof value === 'number') {
      const max = exhaustionMax(rawSystem);
      if (value < 0 || value > max) {
        throw new Error(`Invalid exhaustion ${value}: must be between 0 and ${max}`);
      }
    }
  }
}
