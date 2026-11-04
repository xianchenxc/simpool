import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Avd,
  Emulators,
  adbCalls,
  avdName,
  consolePort,
  parseAdbDevices,
  parseIni,
  pickBaseAvd,
  setIniKeys,
} from "../src/platforms/android.ts";

test("setIniKeys replaces existing keys and appends new ones", () => {
  const text = "AvdId=Pixel_10\nhw.ramSize=2048\n";
  const out = setIniKeys(text, { AvdId: "simpool_android_1", "avd.ini.displayname": "🔒 a · simpool android-1" });
  assert.deepEqual(parseIni(out), {
    AvdId: "simpool_android_1",
    "hw.ramSize": "2048",
    "avd.ini.displayname": "🔒 a · simpool android-1",
  });
  assert.ok(out.endsWith("\n") && !out.endsWith("\n\n"));
});

test("slots map to AVD names and even console ports", () => {
  assert.equal(avdName("android-2"), "simpool_android_2");
  assert.deepEqual([consolePort(5570, "android-1"), consolePort(5570, "android-3")], [5570, 5574]);
});

test("pickBaseAvd takes the newest installed AVD that is not simpool's", () => {
  const avd = (name: string, api: number, isAvailable = true): Avd => ({ name, dir: name, api, isAvailable });
  const avds = [avd("Medium_Phone", 36), avd("Pixel_10", 37.1), avd("simpool_android_1", 38), avd("Broken", 40, false)];
  assert.equal(pickBaseAvd(avds)?.name, "Pixel_10");
  assert.equal(pickBaseAvd(avds, "Medium_Phone")?.name, "Medium_Phone");
  assert.equal(pickBaseAvd(avds, "Nope"), undefined);
});

test("parseAdbDevices and adbCalls read serials and global options", () => {
  const devices = parseAdbDevices("List of devices attached\nemulator-5570\tdevice\nR5CT1\toffline\n\n");
  assert.deepEqual([...devices], [["emulator-5570", "device"], ["R5CT1", "offline"]]);

  assert.deepEqual(adbCalls("cd app && adb -s emulator-5570 install app.apk | tee log"), [
    { serial: "emulator-5570", subcommand: "install" },
  ]);
  assert.deepEqual(adbCalls("$ANDROID_HOME/platform-tools/adb -e shell ls"), [{ pick: "-e", subcommand: "shell" }]);
  assert.deepEqual(adbCalls("adb devices; adb -t 3 shell"), [{ subcommand: "devices" }, { transport: "3", subcommand: "shell" }]);
});

function fakeSdk() {
  const root = mkdtempSync(join(tmpdir(), "simpool-android-"));
  const sdk = join(root, "sdk");
  const avdHome = join(root, "avd");
  mkdirSync(join(sdk, "platform-tools"), { recursive: true });
  mkdirSync(join(sdk, "system-images", "android-37.1", "google_apis", "arm64-v8a"), { recursive: true });
  mkdirSync(join(avdHome, "Pixel_10.avd"), { recursive: true });
  const adb = join(sdk, "platform-tools", "adb");
  writeFileSync(adb, '#!/bin/sh\nprintf "List of devices attached\\nemulator-5570\\tdevice\\nemulator-5554\\tdevice\\nR5CT1\\tdevice\\n"\n');
  chmodSync(adb, 0o755);
  writeFileSync(join(avdHome, "Pixel_10.ini"), `path=${join(avdHome, "Pixel_10.avd")}\ntarget=android-37.1\n`);
  writeFileSync(
    join(avdHome, "Pixel_10.avd", "config.ini"),
    "AvdId=Pixel_10\navd.ini.displayname=Pixel 10\nimage.sysdir.1=system-images/android-37.1/google_apis/arm64-v8a/\n",
  );
  const env = { ANDROID_HOME: sdk, ANDROID_AVD_HOME: avdHome };
  const emus = new Emulators({ size: 2, portBase: 8091, consolePortBase: 5570 }, join(root, "home"), env);
  return { emus, avdHome };
}

test("create clones the base AVD's hardware profile and lists it by serial", () => {
  const { emus, avdHome } = fakeSdk();
  assert.equal(emus.create("android-1", "simpool android-1"), "emulator-5570");

  const config = parseIni(readFileSync(join(avdHome, "simpool_android_1.avd", "config.ini"), "utf8"));
  assert.equal(config.AvdId, "simpool_android_1");
  assert.equal(config["image.sysdir.1"], "system-images/android-37.1/google_apis/arm64-v8a/");
  assert.equal(parseIni(readFileSync(join(avdHome, "simpool_android_1.ini"), "utf8")).target, "android-37.1");

  emus.rename("emulator-5570", "🔒 a · simpool android-1");
  const devices = emus.devices();
  assert.deepEqual(
    devices.find((d) => d.id === "emulator-5570"),
    { id: "emulator-5570", name: "🔒 a · simpool android-1", state: "Booted", isAvailable: true, aliases: ["simpool_android_1"] },
  );
  // The base AVD and an emulator running outside the pool are listed; the phone is not.
  assert.deepEqual(devices.map((d) => d.id).sort(), ["Pixel_10", "emulator-5554", "emulator-5570"]);
  // Creating again reuses the AVD.
  assert.equal(emus.create("android-1", "simpool android-1"), "emulator-5570");
});

test("create refuses ports adb would not discover and names missing base AVDs", () => {
  const { emus } = fakeSdk();
  assert.throws(() => emus.create("android-9", "x"), /beyond what adb discovers/);
  const named = new Emulators({ size: 1, portBase: 8091, consolePortBase: 5570, deviceType: "Nope" }, "/tmp", {
    ANDROID_AVD_HOME: "/nonexistent",
  });
  assert.throws(() => named.create("android-1", "x"), /No AVD named "Nope"/);
});
