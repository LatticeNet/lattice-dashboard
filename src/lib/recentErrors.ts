/**
 * The last errors the console showed, newest first, so a failure toast that
 * was dismissed (or missed) can be read again from the header.
 *
 * Many failures are toast-only (Disable node, a refused rotation, a plan the
 * server would not accept), and their messages carry the server's reason and
 * request id. Before this a toast left after 4 s and took the reason with it.
 *
 * In memory for this tab only: an error log that outlived a reload would
 * describe a session the operator has already left. For the same reason it
 * belongs to one signed-in principal (`belongTo`): a sign-out, an expired
 * session or another operator signing in on the same tab starts it empty.
 * The model is free of Vue so `node --test` covers it; lib/toast.ts feeds it
 * and the header reads it.
 */
export const RECENT_ERRORS_MAX = 20;

/** The same message again within this window is counted, not listed twice. */
export const REPEAT_WINDOW_MS = 5_000;

export interface RecentError {
  id: number;
  message: string;
  detail?: string;
  /** Epoch ms of the latest occurrence. */
  at: number;
  /** How many times it was shown in a row. */
  count: number;
}

export class ErrorLog {
  private items: RecentError[] = [];
  private nextId = 1;
  private owner: string | undefined;
  private readonly max: number;

  constructor(max = RECENT_ERRORS_MAX) {
    this.max = max;
  }

  /** Record one shown error; returns the log, newest first. */
  add(message: string, at: number, detail?: string): RecentError[] {
    const text = message.trim();
    if (!text) return this.list;
    const latest = this.items[0];
    if (latest && latest.message === text && latest.detail === detail && at - latest.at <= REPEAT_WINDOW_MS) {
      this.items = [{ ...latest, at, count: latest.count + 1 }, ...this.items.slice(1)];
      return this.list;
    }
    this.items = [{ id: this.nextId++, message: text, detail, at, count: 1 }, ...this.items].slice(0, this.max);
    return this.list;
  }

  /**
   * Whose session the log describes; undefined when nobody is signed in. A
   * change of owner empties it, since the messages carry server reasons and
   * request ids the next operator on this tab has no business reading.
   * Returns whether it was emptied.
   */
  belongTo(owner: string | undefined): boolean {
    if (owner === this.owner) return false;
    this.owner = owner;
    this.items = [];
    return true;
  }

  clear(): RecentError[] {
    this.items = [];
    return this.list;
  }

  get list(): RecentError[] {
    return this.items;
  }
}
