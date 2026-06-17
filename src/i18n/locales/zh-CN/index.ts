// 简体中文消息。结构与 en 一致:frame 为共享/外壳/落地页文案,各分区文件独立维护,
// 命名空间互不冲突,扁平展开即可安全合并。
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
