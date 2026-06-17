// English messages. The "frame" file holds shared/chrome/landing strings; each
// feature section has its own file so they can be authored independently
// (and translated in parallel) without merge contention. All namespaces are
// distinct, so a flat spread merges them safely.
import frame from "./frame";
import fleet from "./fleet";
import operations from "./operations";
import networking from "./networking";
import proxy from "./proxy";
import platform from "./platform";
import settings from "./settings";

export default {
  ...frame,
  ...fleet,
  ...operations,
  ...networking,
  ...proxy,
  ...platform,
  ...settings,
};
