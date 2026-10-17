/**
 * `?m3=golden` serves the M3 server's golden responses verbatim
 * (src/testing/m3Golden.ts, dev/pathsFixture.ts). The server answered at
 * 2026-09-14 09:47 UTC, so this module moves the page's clock there before
 * anything else reads it: every age, staleness check and "since" the console
 * works out from Date reads as it did when the server answered, and the
 * bodies need no edit. The clock keeps running from that moment.
 *
 * The harness entry imports it first, so it runs before the fixtures take
 * their own `NOW`. Without `?m3=golden` it changes nothing.
 */
import { GOLDEN_NOW } from "@/testing/m3Golden";

if (new URLSearchParams(window.location.search).get("m3") === "golden") {
  const RealDate = Date;
  // Twenty seconds after the server answered, as a page opened just after the read would be.
  const offset = RealDate.parse(GOLDEN_NOW) + 20_000 - RealDate.now();
  class GoldenDate extends RealDate {
    constructor(...args: [] | [string | number | Date] | [number, number, number?, number?, number?, number?, number?]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else if (args.length === 1) super(args[0]);
      else super(...args);
    }

    static override now(): number {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = GoldenDate as DateConstructor;
}
