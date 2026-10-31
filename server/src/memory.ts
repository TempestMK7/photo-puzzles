import { Signer } from './signing';
import type { AccountRecord, Ban, Clock, FileRecord, Media, PubSub, RateCounter, Random, Report, RoomRecord, Store } from './types';

/** Everything in memory: for the tests and for the local server (which forgets it all when it stops). */
export class MemoryStore implements Store {
  private rooms = new Map<string, RoomRecord>();
  private codes = new Map<string, string>();
  private accounts = new Map<string, AccountRecord>();
  private names = new Map<string, string>();
  private reports: Report[] = [];
  private banned = new Map<string, Ban>();
  private files = new Map<string, FileRecord>();
  private fileUsers = new Map<string, Set<string>>();

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

  async getAccount(playerId: string): Promise<AccountRecord | undefined> {
    const a = this.accounts.get(playerId);
    return a && { ...a };
  }

  async putAccount(account: AccountRecord): Promise<boolean> {
    const had = this.accounts.get(account.id);
    if (had ? had.rev !== account.rev - 1 : account.rev !== 0) return false;
    this.accounts.set(account.id, { ...account });
    return true;
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

  async getFile(id: string): Promise<FileRecord | undefined> {
    const f = this.files.get(id);
    return f && { ...f, video: f.video && { ...f.video } };
  }

  async putFile(file: FileRecord): Promise<void> {
    this.files.set(file.id, { ...file, video: file.video && { ...file.video } });
  }

  async deleteFile(id: string): Promise<void> {
    this.files.delete(id);
    this.fileUsers.delete(id);
  }

  async addFileUser(fileId: string, playerId: string): Promise<void> {
    if (!this.fileUsers.has(fileId)) this.fileUsers.set(fileId, new Set());
    this.fileUsers.get(fileId)!.add(playerId);
  }

  async hasFileUser(fileId: string, playerId: string): Promise<boolean> {
    return this.fileUsers.get(fileId)?.has(playerId) ?? false;
  }

  async filesOf(playerId: string): Promise<string[]> {
    return [...this.files.values()].filter((f) => f.ownerId === playerId).map((f) => f.id);
  }

  async allFiles(): Promise<FileRecord[]> {
    return [...this.files.values()].map((f) => ({ ...f, video: f.video && { ...f.video } }));
  }

  async forgetPlayer(playerId: string): Promise<void> {
    this.names.delete(playerId);
    this.accounts.delete(playerId);
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

  /** The local server is sent the video itself, at the address that is signed here (see `RoomService.storeVideo`). */
  async videoUpload(roomId: string, _type: string, _bytes: number): Promise<{ url: string; headers: Record<string, string> }> {
    return { url: (await this.signer.address(this.base, roomId, 'put')).replace(`/media/${encodeURIComponent(roomId)}`, `/media/${encodeURIComponent(roomId)}/video`), headers: {} };
  }

  async inspect(roomId: string, peek: number): Promise<{ bytes: number; head: Uint8Array } | undefined> {
    const f = this.files.get(roomId);
    return f ? { bytes: f.bytes.length, head: f.bytes.slice(0, peek) } : undefined;
  }

  has(roomId: string): boolean {
    return this.files.has(roomId);
  }

  /** A kept file is stored under its own name (`file~<id>`), which no room's id can be. */
  async keepFile(roomId: string, fileId: string): Promise<void> {
    const f = this.files.get(roomId);
    if (!f) throw new Error('nothing stored for the room');
    this.files.set(fileName(fileId), { bytes: f.bytes.slice(), type: f.type });
  }

  async useFile(fileId: string, roomId: string): Promise<boolean> {
    const f = this.files.get(fileName(fileId));
    if (!f) return false;
    this.files.set(roomId, { bytes: f.bytes.slice(), type: f.type });
    return true;
  }

  async deleteFile(fileId: string): Promise<void> {
    this.files.delete(fileName(fileId));
  }

  fileUrl(fileId: string): Promise<string> {
    return this.signer.address(this.base, fileName(fileId), 'get');
  }
}

const fileName = (fileId: string): string => `file~${fileId}`;

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
