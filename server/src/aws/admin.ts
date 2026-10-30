import type { RoomService } from '../service';
import { buildService } from './api';

/**
 * The operator's tools: a function with no address of its own, which only someone allowed to invoke it (an IAM user of this account) can call, with
 * `aws lambda invoke --function-name <Admin function of the Api stack> --cli-binary-format raw-in-base64-out --payload '{"cmd":"reports"}' out.json` (see infra/README.md).
 *
 *   { cmd: 'reports', days?: 30 }       the reports of the last days, newest first
 *   { cmd: 'room', id }                 a puzzle: who made it, who is in it, and a short-lived address of its picture
 *   { cmd: 'remove-room', id }          ends a puzzle now (the picture and the codes go; the players are told)
 *   { cmd: 'ban', id, reason? }         stops a player (an account's id is its `sub`) from playing online: they leave every puzzle and the ones they made end
 *   { cmd: 'unban', id }
 *   { cmd: 'bans' }
 *   { cmd: 'delete-account', id }       deletes an account the way its owner can in the game: the puzzles it made end, it leaves the others, its name and records go, and then the account
 */
export type AdminCommand =
  | { cmd: 'reports'; days?: number }
  | { cmd: 'room'; id: string }
  | { cmd: 'remove-room'; id: string }
  | { cmd: 'ban'; id: string; reason?: string }
  | { cmd: 'unban'; id: string }
  | { cmd: 'bans' }
  | { cmd: 'delete-account'; id: string };

const ID = /^[\w-]{1,128}$/;
const isId = (id: unknown): id is string => typeof id === 'string' && ID.test(id);

export function makeAdmin(service: RoomService) {
  return async (event: AdminCommand): Promise<unknown> => {
    const bad = (error: string) => ({ ok: false, error });
    switch (event?.cmd) {
      case 'reports': {
        const days = event.days === undefined ? 30 : event.days;
        return typeof days === 'number' && days > 0 && days <= 90 ? { ok: true, reports: await service.adminReports(days) } : bad('days must be between 0 and 90');
      }
      case 'room': {
        if (!isId(event.id)) return bad('id');
        const room = await service.adminRoom(event.id);
        return room ? { ok: true, room } : bad('no such puzzle (it may have ended)');
      }
      case 'remove-room':
        if (!isId(event.id)) return bad('id');
        return (await service.adminRemoveRoom(event.id)) ? { ok: true } : bad('no such puzzle (it may have ended)');
      case 'ban':
        if (!isId(event.id)) return bad('id');
        await service.adminBan(event.id, typeof event.reason === 'string' ? event.reason : '');
        return { ok: true };
      case 'unban':
        if (!isId(event.id)) return bad('id');
        await service.adminUnban(event.id);
        return { ok: true };
      case 'bans':
        return { ok: true, bans: await service.adminBans() };
      case 'delete-account': {
        if (!isId(event.id)) return bad('id');
        const done = await service.adminDeleteAccount(event.id);
        return done.ok ? { ok: true } : bad('part of it could not be done: run it again');
      }
      default:
        return bad('cmd must be one of reports, room, remove-room, ban, unban, bans, delete-account');
    }
  };
}

let admin: Promise<(event: AdminCommand) => Promise<unknown>> | undefined;

export const handler = async (event: AdminCommand): Promise<unknown> => {
  admin ??= buildService()
    .then(({ service }) => makeAdmin(service))
    .catch((e) => {
      admin = undefined;                       // try again at the next call
      throw e;
    });
  return (await admin)(event);
};
