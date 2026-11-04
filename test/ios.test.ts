import assert from "node:assert/strict";
import { test } from "node:test";
import { type Runtime, chooseDevice, pickDeviceType } from "../src/platforms/ios.ts";

function runtime(version: string, types: string[], extra: Partial<Runtime> = {}): Runtime {
  return {
    identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace(".", "-")}`,
    version,
    platform: "iOS",
    isAvailable: true,
    supportedDeviceTypes: types.map((name) => ({ name, identifier: name })),
    ...extra,
  };
}

test("pickDeviceType prefers the highest-numbered plain iPhone", () => {
  assert.equal(pickDeviceType(["iPhone 16", "iPhone 17 Pro", "iPhone 17", "iPhone Air"]), "iPhone 17");
  assert.equal(pickDeviceType(["iPad Pro", "iPhone Duo"]), "iPhone Duo");
});

test("chooseDevice skips a newer runtime that only offers a special device", () => {
  const runtimes = [
    runtime("27.1", ["iPhone Duo"]),
    runtime("27.0", ["iPhone 17 Pro", "iPhone 17", "iPhone 16"]),
    runtime("26.0", ["iPhone 17", "iPhone 16"]),
  ];
  assert.deepEqual(chooseDevice(runtimes), { deviceType: "iPhone 17", runtime: runtimes[1]?.identifier });
});

test("chooseDevice honours a configured type and ignores unavailable runtimes", () => {
  const runtimes = [
    runtime("27.1", ["iPhone Duo"]),
    runtime("27.0", ["iPhone 17"], { isAvailable: false }),
    runtime("26.0", ["iPhone 17"]),
  ];
  assert.deepEqual(chooseDevice(runtimes, "iPhone Duo"), { deviceType: "iPhone Duo", runtime: runtimes[0]?.identifier });
  assert.deepEqual(chooseDevice(runtimes, "iPhone 17"), { deviceType: "iPhone 17", runtime: runtimes[2]?.identifier });
  assert.equal(chooseDevice(runtimes, "iPhone 99"), undefined);
});
