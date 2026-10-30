import { Signer } from './signing';
import type { Ban, Clock, Media, PubSub, RateCounter, Random, Report, RoomRecord, Store } from './types';

/** Everything in memory: for the tests and for the local server (which forgets it all when it stops). */
export class MemoryStore implements Store {
  private rooms = new Map<string, RoomRecord>();
  private codes = new Map<string, string>();
  private creations = new Map<string, number[]>();
  private names = new Map<string, string>();
  private reports: Report[] = [];
  private banned = new Map<string, Ban>();

  async getRoom(id: string): Promise<RoomRecord | undefined> {
    const r = this.rooms.get(id);
    return r && structuredClone(r);                       // a copy, as a database gives: changing it changes nothing until it is written
  }

  async putRoom(room: RoomRecord): Promise<boolean> {
    const had = this.rooms.get(room.id);
    if (had ? had.rev !== room.rev - 1 : room.rev !== 0) return false;
    this.rooms.set(room.id, structuredClone(room));
    return true;
  }

  async deleteRoom(id: string): Promise<void> {
    this.rooms.delete(id);
  }

  async claimCode(code: string, roomId: string): Promise<boolean> {
    if (this.codes.has(code)) return false;
    this.codes.set(code, roomId);
    return true;
  }

  async roomOfCode(code: string): Promise<string | undefined> {
    return this.codes.get(code);
  }

  async releaseCode(code: string): Promise<void> {
    this.codes.delete(code);
  }

  async roomsOf(playerId: string): Promise<string[]> {
    return [...this.rooms.values()].filter((r) => r.members.some((m) => m.id === playerId)).map((r) => r.id);
  }

  async allRooms(): Promise<RoomRecord[]> {
    return [...this.rooms.values()].map((r) => structuredClone(r));
  }

  async creationsSince(playerId: string, since: number): Promise<number[]> {
    return (this.creations.get(playerId) ?? []).filter((t) => t > since);
  }

  async addCreation(playerId: string, at: number): Promise<void> {
    this.creations.set(playerId, [...(this.creations.get(playerId) ?? []), at]);
  }

  async getName(playerId: string): Promise<string | undefined> {
    return this.names.get(playerId);
  }

  async setName(playerId: string, name: string): Promise<void> {
    this.names.set(playerId, name);
  }

  async addReport(report: Report): Promise<void> {
    this.reports.push(structuredClone(report));
  }

  async reportsSince(since: number): Promise<Report[]> {
    return this.reports.filter((r) => r.at >= since).sort((a, b) => b.at - a.at).map((r) => structuredClone(r));
  }

  async ban(ban: Ban): Promise<void> {
    this.banned.set(ban.playerId, { ...ban });
  }

  async unban(playerId: string): Promise<void> {
    this.banned.delete(playerId);
  }

  async getBan(playerId: string): Promise<Ban | undefined> {
    const b = this.banned.get(playerId);
    return b && { ...b };
  }

  async bans(): Promise<Ban[]> {
    return [...this.banned.values()].map((b) => ({ ...b }));
  }

  async forgetPlayer(playerId: string): Promise<void> {
    this.names.delete(playerId);
    this.creations.delete(playerId);
  }
}

export class MemoryMedia implements Media {
  private files = new Map<string, { bytes: Uint8Array; type: string }>();

  private readonly signer: Signer;

  constructor(
    private readonly base: string,
    key: Uint8Array,
    clock: Clock,
    lifeMs = 10 * 60 * 1000,
  ) {
    this.signer = new Signer(key, clock, lifeMs);
  }

  uploadUrl(roomId: string): Promise<string> {
    return this.signer.address(this.base, roomId, 'put');
  }

  signedUrl(roomId: string): Promise<string> {
    return this.signer.address(this.base, roomId, 'get');
  }

  allows(roomId: string, what: 'put' | 'get', exp: string | null, sig: string | null): Promise<boolean> {
    return this.signer.allows(roomId, what, exp, sig);
  }

  async put(roomId: string, bytes: Uint8Array, type: string): Promise<void> {
    this.files.set(roomId, { bytes, type });
  }

  get(roomId: string): { bytes: Uint8Array; type: string } | undefined {
    return this.files.get(roomId);
  }

  async delete(roomId: string): Promise<void> {
    this.files.delete(roomId);
  }

  has(roomId: string): boolean {
    return this.files.has(roomId);
  }
}

/** Remembers what was published and hands it to whoever listens. */
export class MemoryPubSub implements PubSub {
  readonly published: { topic: string; message: unknown }[] = [];
  private listeners = new Set<(topic: string, message: unknown) => void>();

  async publish(topic: string, message: unknown): Promise<void> {
    this.published.push({ topic, message });
    for (const l of this.listeners) l(topic, message);
  }

  listen(fn: (topic: string, message: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Counts in fixed windows (the windows are those of the clock, as in DynamoDB: a new one starts at every multiple of its length). */
export class MemoryRates implements RateCounter {
  private counts = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  private slot(key: string, windowMs: number): string {
    return `${key}#${Math.floor(this.clock.now() / windowMs)}`;
  }

  async add(key: string, windowMs: number): Promise<number> {
    const k = this.slot(key, windowMs);
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    return n;
  }

  async count(key: string, windowMs: number): Promise<number> {
    return this.counts.get(this.slot(key, windowMs)) ?? 0;
  }
}

export class SystemRandom implements Random {
  bytes(n: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  below(n: number): number {
    return Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296) * n);
  }
}

export const systemClock: Clock = { now: () => Date.now() };
