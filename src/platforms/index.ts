import { android } from "./android.ts";
import type { PlatformDriver } from "./driver.ts";
import { ios } from "./ios.ts";

/** Every platform simpool pools. A new platform is one driver file and one entry here. */
export const DRIVERS: PlatformDriver[] = [ios, android];
